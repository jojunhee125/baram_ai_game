CREATE TABLE trade_settlement (
  trade_id text PRIMARY KEY CHECK (length(trade_id) BETWEEN 1 AND 128),
  first_owner_key uuid NOT NULL,
  second_owner_key uuid NOT NULL,
  request jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (first_owner_key < second_owner_key)
);
