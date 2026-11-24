export interface DiscussionThread {
  uuid: string;
  model: string;
  author: string;
  title: string;
  body: string;
  created_at: string;
  reply_count: number;
}

export interface DiscussionReply {
  uuid: string;
  discussion: string; // thread uuid
  author: string;
  body: string;
  created_at: string;
}
