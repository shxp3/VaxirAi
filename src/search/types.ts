export interface GroundingResult {
  context: string;
  sources: { index: number; title: string; url: string }[];
}
export interface WebGrounder {
  shouldSearch(query: string): boolean;
  search(query: string): Promise<GroundingResult | null>;
}
