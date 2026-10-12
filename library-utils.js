(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LibraryUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  const filterResources = (resources, { query = '', branch = 'all', year = 'all', semester = 'all', subject = 'all', resourceType = 'all' } = {}) => {
    const search = query.trim().toLowerCase();
    return resources.filter((resource) => {
      const haystack = `${resource.title || ''} ${resource.subject || ''} ${resource.academic_year || ''} ${resource.uploader_name || ''}`.toLowerCase();
      return (!search || haystack.includes(search))
        && (branch === 'all' || resource.branch === branch)
        && (year === 'all' || resource.year === year)
        && (semester === 'all' || resource.semester === semester)
        && (subject === 'all' || resource.subject === subject)
        && (resourceType === 'all' || resource.resource_type === resourceType);
    });
  };

  const validateResourceFile = (file) => Boolean(
    file
      && file.size <= MAX_FILE_SIZE
      && /\.pdf$/i.test(file.name || '')
      && (!file.type || file.type === 'application/pdf')
  );

  const sanitizeFileName = (name, id = '') => {
    const base = String(name || '').toLowerCase().replace(/\.pdf$/i, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    return `${base || 'resource'}${id ? `-${id}` : ''}.pdf`;
  };

  return { MAX_FILE_SIZE, filterResources, validateResourceFile, sanitizeFileName };
});
