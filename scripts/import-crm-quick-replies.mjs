import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const result = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--dry-run') result.dryRun = true;
    else if (value === '--source-backend') result.sourceBackend = argv[++index];
    else if (value === '--target-user-data') result.targetUserData = argv[++index];
  }
  if (!result.sourceBackend || !result.targetUserData) {
    throw new Error('Cần truyền --source-backend và --target-user-data.');
  }
  return result;
}

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function normalizeKeyword(value) {
  return String(value || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
}

export function allocateKeyword(preferred, occupied) {
  const base = normalizeKeyword(preferred) || 'mau';
  let keyword = base;
  let suffix = 2;
  while (occupied.has(keyword.toLocaleLowerCase('vi'))) {
    const tail = `-${suffix}`;
    keyword = `${base.slice(0, Math.max(1, 40 - tail.length))}${tail}`;
    suffix += 1;
  }
  occupied.add(keyword.toLocaleLowerCase('vi'));
  return keyword;
}

export function getAttachments(template) {
  const richAttachments = template.contentRich && Array.isArray(template.contentRich.attachments)
    ? template.contentRich.attachments
    : [];
  return richAttachments.filter((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
}

function extensionFromUrl(value) {
  try {
    const extension = path.extname(new URL(value).pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return extension;
  } catch {}
  return '.img';
}

async function downloadFirstImage(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!['http:', 'https:'].includes(new URL(response.url).protocol)) throw new Error('redirect không an toàn');
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('nội dung tải về không phải ảnh');
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 20 * 1024 * 1024) throw new Error('ảnh lớn hơn 20 MB');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 20 * 1024 * 1024) throw new Error('ảnh lớn hơn 20 MB');
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isJpeg && !isPng && !isGif && !isWebp) throw new Error('dữ liệu ảnh không hợp lệ');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  await fs.writeFile(temporary, bytes);
  await fs.rename(temporary, destination);
}

async function loadSourceTemplates(sourceBackend) {
  const env = parseEnv(await fs.readFile(path.join(sourceBackend, '.env'), 'utf8'));
  if (!env.DATABASE_URL) throw new Error('Không tìm thấy DATABASE_URL trong backend/.env.');

  const prismaModule = await import(pathToFileURL(path.join(sourceBackend, 'node_modules', '@prisma', 'client', 'default.js')).href);
  const adapterModule = await import(pathToFileURL(path.join(sourceBackend, 'node_modules', '@prisma', 'adapter-pg', 'dist', 'index.js')).href);
  const prisma = new prismaModule.PrismaClient({
    adapter: new adapterModule.PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    return await prisma.messageTemplate.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        shortcut: true,
        content: true,
        contentRich: true,
        category: true,
        tagIds: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourceBackend = path.resolve(options.sourceBackend);
  const targetUserData = path.resolve(options.targetUserData);
  const workspaceIndexPath = path.join(targetUserData, 'workspaces', 'index.json');
  const workspaceIndex = JSON.parse(await fs.readFile(workspaceIndexPath, 'utf8'));
  const currentWorkspace = workspaceIndex.workspaces.find((workspace) => workspace.id === workspaceIndex.currentId);
  if (!currentWorkspace) throw new Error('Không tìm thấy workspace đang hoạt động.');

  const workspacePath = path.join(targetUserData, 'workspaces', currentWorkspace.id, 'data.json');
  const workspaceData = JSON.parse(await fs.readFile(workspacePath, 'utf8'));
  const existingReplies = Array.isArray(workspaceData.quickReplies) ? workspaceData.quickReplies : [];
  const sourceTemplates = await loadSourceTemplates(sourceBackend);
  const validTemplates = sourceTemplates.filter((template) => template.shortcut?.trim() && template.content?.trim());
  const importedBySourceId = new Map(
    existingReplies
      .filter((reply) => reply?.sourceSystem === 'nhayen-crm' && reply.sourceTemplateId)
      .map((reply) => [reply.sourceTemplateId, reply]),
  );
  const occupied = new Set(
    existingReplies
      .filter((reply) => reply?.sourceSystem !== 'nhayen-crm')
      .map((reply) => normalizeKeyword(reply.keyword).toLocaleLowerCase('vi'))
      .filter(Boolean),
  );
  const imageDirectory = path.join(targetUserData, 'quick-reply-images', 'nhayen-crm');
  const failures = [];
  let downloadedImages = 0;
  let reusedImages = 0;
  let created = 0;
  let updated = 0;

  const importedReplies = [];
  for (const template of validTemplates) {
    const previous = importedBySourceId.get(template.id);
    const keyword = previous?.keyword && !occupied.has(normalizeKeyword(previous.keyword).toLocaleLowerCase('vi'))
      ? normalizeKeyword(previous.keyword)
      : allocateKeyword(template.shortcut, occupied);
    occupied.add(keyword.toLocaleLowerCase('vi'));

    const attachments = getAttachments(template);
    let imagePath = previous?.imagePath || '';
    if (attachments.length) {
      const extension = extensionFromUrl(attachments[0]);
      const expectedPath = path.join(imageDirectory, `${template.id}${extension}`);
      try {
        await fs.access(expectedPath);
        imagePath = expectedPath;
        reusedImages += 1;
      } catch {
        if (!options.dryRun) {
          try {
            await downloadFirstImage(attachments[0], expectedPath);
            imagePath = expectedPath;
            downloadedImages += 1;
          } catch (error) {
            imagePath = '';
            failures.push({ sourceTemplateId: template.id, shortcut: template.shortcut, reason: error.message });
          }
        }
      }
    }

    if (previous) updated += 1;
    else created += 1;
    importedReplies.push({
      keyword,
      message: template.content.trim(),
      imagePath,
      sourceSystem: 'nhayen-crm',
      sourceTemplateId: template.id,
      sourceName: template.name || '',
      sourceCategory: template.category || '',
      sourceTagIds: Array.isArray(template.tagIds) ? template.tagIds : [],
      sourceAttachmentUrls: attachments,
      sourceUpdatedAt: template.updatedAt instanceof Date ? template.updatedAt.toISOString() : String(template.updatedAt || ''),
    });
  }

  const retainedReplies = existingReplies.filter((reply) => reply?.sourceSystem !== 'nhayen-crm');
  const nextData = { ...workspaceData, quickReplies: [...retainedReplies, ...importedReplies] };
  let backupPath = null;
  if (!options.dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDirectory = path.join(targetUserData, 'backups', 'quick-replies');
    await fs.mkdir(backupDirectory, { recursive: true });
    backupPath = path.join(backupDirectory, `${currentWorkspace.id}-${stamp}.json`);
    await fs.copyFile(workspacePath, backupPath);
    const temporaryWorkspacePath = `${workspacePath}.importing`;
    await fs.writeFile(temporaryWorkspacePath, `${JSON.stringify(nextData, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryWorkspacePath, workspacePath);
  }

  console.log(JSON.stringify({
    dryRun: options.dryRun,
    workspaceId: currentWorkspace.id,
    workspaceName: currentWorkspace.name,
    sourceActiveTemplates: sourceTemplates.length,
    validTemplates: validTemplates.length,
    retainedExistingReplies: retainedReplies.length,
    created,
    updated,
    finalReplyCount: nextData.quickReplies.length,
    templatesWithAttachments: validTemplates.filter((template) => getAttachments(template).length).length,
    downloadedImages,
    reusedImages,
    imageFailures: failures,
    backupPath,
    workspacePath,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
