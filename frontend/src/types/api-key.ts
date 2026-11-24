export interface IApiKey {
  id: string;
  name: string;
  prefix: string;
  key?: string; // Only present on creation
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
}
