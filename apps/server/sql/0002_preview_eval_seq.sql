-- 光线预演台：每个库一支单调递增的试算序号。
-- 预演结果本身不落库，序号仅用于响应溯源与前端丢弃乱序到达的旧结果；
-- 因此这里不存任何条件、坐标或天气快照。
CREATE TABLE IF NOT EXISTS preview_eval_seq (
  library_id TEXT PRIMARY KEY REFERENCES library(id) ON DELETE CASCADE,
  next_val  INTEGER NOT NULL DEFAULT 1
);
