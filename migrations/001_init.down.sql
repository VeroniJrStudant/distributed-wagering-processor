DROP TRIGGER IF EXISTS ledger_matches_wallet ON wallet_ledger_entries;
DROP TRIGGER IF EXISTS wallets_match_ledger_on_update ON wallets;
DROP TRIGGER IF EXISTS wallets_match_ledger_on_insert ON wallets;
DROP TRIGGER IF EXISTS wallet_ledger_entries_chain ON wallet_ledger_entries;
DROP TRIGGER IF EXISTS wager_transactions_protect ON wager_transactions;
DROP TRIGGER IF EXISTS wallet_ledger_entries_no_delete ON wallet_ledger_entries;
DROP TRIGGER IF EXISTS wallet_ledger_entries_no_update ON wallet_ledger_entries;

DROP FUNCTION IF EXISTS assert_wallet_matches_ledger();
DROP FUNCTION IF EXISTS assert_ledger_chain();
DROP FUNCTION IF EXISTS protect_wager_transaction();
DROP FUNCTION IF EXISTS prevent_ledger_mutation();

DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;
