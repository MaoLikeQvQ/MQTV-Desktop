/** 移除搜索词中的全部空白和 Unicode 分隔符，统一输入、联想与各来源的请求关键词。 */
export function normalizeSearchKeyword(value: string): string {
  return value.replace(/[\s\p{Z}]+/gu, '');
}
