-- Financial invariants enforced by the schema:
-- * wallet balance is numeric(19,2) and never negative
-- * balance equals the ledger sum (deferred constraint triggers)
-- * ledger lines are append-only and arithmetically balanced
-- * one ledger line per wager transaction
-- * a reference can be reversed only once, whichever kind comes first
-- * terminal wager rows cannot be updated

CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  player_id uuid NOT NULL,
  currency text NOT NULL,
  balance numeric(19, 2) NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT wallets_version_positive CHECK (version >= 1),
  CONSTRAINT wallets_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency)
);

CREATE TABLE wager_transactions (
  id uuid PRIMARY KEY,
  provider_id text NOT NULL,
  external_transaction_id text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  wallet_id uuid NOT NULL REFERENCES wallets (id),
  player_id uuid NOT NULL,
  round_id text NOT NULL,
  game_id text NOT NULL,
  kind text NOT NULL,
  amount numeric(19, 2) NOT NULL,
  currency text NOT NULL,
  reference_external_transaction_id text,
  status text NOT NULL,
  reference_transaction_id uuid,
  failure_code text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  observed_balance numeric(19, 2) NOT NULL,
  observed_currency text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL,
  processed_at timestamptz,
  CONSTRAINT wager_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT wager_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_observed_currency_iso CHECK (observed_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_kind_check CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
  CONSTRAINT wager_status_check CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
  CONSTRAINT wager_attempt_non_negative CHECK (attempt_count >= 0),
  CONSTRAINT wager_failure_code_required CHECK (status NOT IN ('REJECTED', 'FAILED') OR failure_code IS NOT NULL),
  CONSTRAINT wager_processed_at_required CHECK (status NOT IN ('PROCESSED', 'REJECTED', 'FAILED') OR processed_at IS NOT NULL),
  CONSTRAINT wager_opening_internal CHECK (kind <> 'OPENING' OR provider_id = 'internal'),
  CONSTRAINT wager_next_attempt_only_pending CHECK (next_attempt_at IS NULL OR status = 'PENDING_REFERENCE'),
  CONSTRAINT wager_idempotency_unique UNIQUE (idempotency_key),
  CONSTRAINT wager_external_unique UNIQUE (provider_id, external_transaction_id)
);

CREATE UNIQUE INDEX wager_reversal_once
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';

CREATE INDEX wager_pending_reference_due
  ON wager_transactions (next_attempt_at, created_at)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX wager_waiting_on_reference
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';

CREATE TABLE wallet_ledger_entries (
  id uuid PRIMARY KEY,
  wallet_id uuid NOT NULL REFERENCES wallets (id),
  transaction_id uuid NOT NULL UNIQUE REFERENCES wager_transactions (id),
  direction text NOT NULL,
  amount numeric(19, 2) NOT NULL,
  currency text NOT NULL,
  balance_before numeric(19, 2) NOT NULL,
  balance_after numeric(19, 2) NOT NULL,
  created_at timestamptz NOT NULL,
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  CONSTRAINT ledger_direction_check CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ledger_amount_positive CHECK (amount > 0),
  CONSTRAINT ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ledger_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ledger_arithmetic CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR
    (direction = 'DEBIT' AND balance_after = balance_before - amount)
  )
);

CREATE INDEX ledger_wallet_order ON wallet_ledger_entries (wallet_id, position);

CREATE TABLE inbox_messages (
  consumer_name text NOT NULL,
  message_id text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);

CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  published_at timestamptz,
  locked_by text,
  locked_until timestamptz,
  CONSTRAINT outbox_attempts_non_negative CHECK (attempts >= 0)
);

CREATE INDEX outbox_pending ON outbox_messages (occurred_at) WHERE published_at IS NULL;

CREATE FUNCTION prevent_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger entries are immutable';
END;
$$;

CREATE TRIGGER wallet_ledger_entries_no_update
  BEFORE UPDATE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE TRIGGER wallet_ledger_entries_no_delete
  BEFORE DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_ledger_mutation();

CREATE FUNCTION protect_wager_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminal wager transaction is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wager_transactions_protect
  BEFORE UPDATE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION protect_wager_transaction();

CREATE FUNCTION assert_ledger_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous numeric(19, 2);
  wallet_currency text;
BEGIN
  SELECT currency INTO wallet_currency FROM wallets WHERE id = NEW.wallet_id;
  IF wallet_currency IS NULL THEN
    RAISE EXCEPTION 'ledger wallet % does not exist', NEW.wallet_id;
  END IF;
  IF wallet_currency <> NEW.currency THEN
    RAISE EXCEPTION 'ledger currency must match wallet currency';
  END IF;

  SELECT balance_after INTO previous
  FROM wallet_ledger_entries
  WHERE wallet_id = NEW.wallet_id
  ORDER BY position DESC
  LIMIT 1;

  IF previous IS NULL THEN
    IF NEW.balance_before <> 0 THEN
      RAISE EXCEPTION 'first ledger entry must start from a zero balance';
    END IF;
  ELSIF previous <> NEW.balance_before THEN
    RAISE EXCEPTION 'ledger chain broken for wallet %', NEW.wallet_id;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_ledger_entries_chain
  BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_chain();

CREATE FUNCTION assert_wallet_matches_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  wallet_uuid uuid;
  stored numeric(19, 2);
  calculated numeric(19, 2);
BEGIN
  IF TG_TABLE_NAME = 'wallets' THEN
    wallet_uuid := NEW.id;
  ELSE
    wallet_uuid := NEW.wallet_id;
  END IF;

  SELECT balance INTO stored FROM wallets WHERE id = wallet_uuid;
  SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
    INTO calculated
  FROM wallet_ledger_entries
  WHERE wallet_id = wallet_uuid;

  IF stored IS DISTINCT FROM calculated THEN
    RAISE EXCEPTION 'wallet % balance % diverges from ledger %', wallet_uuid, stored, calculated;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER wallets_match_ledger_on_insert
  AFTER INSERT ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();

CREATE CONSTRAINT TRIGGER wallets_match_ledger_on_update
  AFTER UPDATE OF balance ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();

CREATE CONSTRAINT TRIGGER ledger_matches_wallet
  AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_wallet_matches_ledger();
