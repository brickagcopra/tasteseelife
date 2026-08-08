/**
 * Audit resource kinds for the content bounded context (the `resourceKind`
 * column on the audit row). Snake_case slugs matching the Prisma table names.
 */
export const CONTENT_AUDIT_RESOURCE = {
  page: 'content_page',
  pageVersion: 'content_page_version',
  article: 'content_article',
  articleVersion: 'content_article_version',
  helpCategory: 'content_help_category',
  author: 'content_author',
} as const;
