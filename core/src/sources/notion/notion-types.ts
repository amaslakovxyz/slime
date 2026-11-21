// The parts of Notion's API objects the adapter reads (API version 2025-09-03).
// Only these fields are kept in recorded fixtures (P5.5).
export interface NotionOption {
  name: string;
}

export interface NotionPropertySchema {
  name: string;
  type: string;
  description?: string | null;
  select?: { options: NotionOption[] };
  status?: { options: NotionOption[] };
}

export interface NotionDataSource {
  id: string;
  title?: { plain_text: string }[];
  properties: Record<string, NotionPropertySchema>;
}

export interface NotionRichText {
  plain_text: string;
}

/** One page property value; only the field named by `type` is set. */
export interface NotionPropertyValue {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  number?: number | null;
  select?: NotionOption | null;
  status?: NotionOption | null;
  multi_select?: NotionOption[];
  date?: { start: string } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  unique_id?: { prefix: string | null; number: number | null };
  created_time?: string;
  last_edited_time?: string;
}

export interface NotionPage {
  id: string;
  properties: Record<string, NotionPropertyValue>;
}

export interface NotionQueryResult {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
  request_status?: { type: string };
}

export interface NotionUser {
  name?: string | null;
}
