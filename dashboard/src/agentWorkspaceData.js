function normalizeWorkspaceEntry(entry) {
  if (typeof entry === 'string') {
    const path = entry.trim().replace(/^\.\//, '').replace(/\/$/, '');
    if (!path) return null;
    return {
      path,
      type: 'file',
    };
  }

  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
    return null;
  }

  const path = entry.path.trim().replace(/^\.\//, '').replace(/\/$/, '');
  if (!path) return null;

  return {
    path,
    type: entry.type === 'directory' ? 'directory' : 'file',
    size: Number.isFinite(entry.size) ? entry.size : undefined,
  };
}

export function normalizeWorkspaceEntriesResponse(data) {
  const rawEntries = Array.isArray(data)
    ? data
    : Array.isArray(data?.entries)
      ? data.entries
      : Array.isArray(data?.files)
        ? data.files
        : [];

  return rawEntries
    .map((entry) => normalizeWorkspaceEntry(entry))
    .filter(Boolean);
}

function stringifyWorkspaceContent(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function normalizeWorkspaceFileContentResponse(data) {
  if (typeof data?.file?.content !== 'undefined') {
    return stringifyWorkspaceContent(data.file.content);
  }
  if (typeof data?.file_content !== 'undefined') {
    return stringifyWorkspaceContent(data.file_content);
  }
  if (typeof data?.content !== 'undefined') {
    return stringifyWorkspaceContent(data.content);
  }
  return '';
}