export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
}

export interface PageResult<T> {
  data: T[];
  meta: PageMeta;
}

export function pageMeta(page: number, limit: number, total: number): PageMeta {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  return { page, limit, total, totalPages, hasNext: page < totalPages };
}
