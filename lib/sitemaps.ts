// lib/sitemaps.ts
// Shared types for the sitemap picker (server route + browser).

/** One sitemap file found for a property. */
export type SitemapFile = {
  url: string;
  /** The sitemap index this file is listed in, or null for top-level files. */
  parent: string | null;
  /** Where a top-level file was found: "Search Console", "robots.txt" or "/sitemap.xml". Empty for files inside an index. */
  foundIn: string;
  /** index = lists other sitemaps; urlset = lists pages; unread = not opened (time limit); error = couldn't be read. */
  type: "index" | "urlset" | "unread" | "error";
  /** Number of page URLs in the file (urlset only). */
  urls: number | null;
  /** Number of sitemap files listed (index only). */
  children: number | null;
  /** Pages Search Console says were submitted in this file (only for sitemaps submitted in Search Console). */
  submitted: number | null;
  /** <lastmod> from the parent index, if given. */
  lastmod?: string;
  error?: string;
};

export type SitemapList = { files: SitemapFile[]; note: string };
