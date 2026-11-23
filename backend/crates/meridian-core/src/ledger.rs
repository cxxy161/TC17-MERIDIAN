//! Fixed-point money conservation ledger.

use serde::{Deserialize, Serialize};

use crate::types::Money;

/// Tracks cumulative base money minted/reclaimed so conservation invariants hold to exact i64 micro-units.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MoneyLedger {
    pub total_minted: i128,
    pub total_burned: i128,
    pub total_trade_fees: i128,
    pub total_storage_fees: i128,
    pub total_wages_paid: i128,
}

impl MoneyLedger {
    #[inline]
    pub fn record_mint(&mut self, amount: Money) {
        if amount > 0 {
            self.total_minted += amount as i128;
        }
    }

    #[inline]
    pub fn record_burn(&mut self, amount: Money) {
        if amount > 0 {
            self.total_burned += amount as i128;
        }
    }

    #[inline]
    pub fn expected_circulation(&self) -> i128 {
        self.total_minted - self.total_burned
    }
}
