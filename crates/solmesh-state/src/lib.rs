//! Canonical off-chain state-channel message, shared by the on-chain program and
//! (via golden-bytes parity tests) the TypeScript client. Borsh layout MUST stay
//! byte-identical on both sides — that is the whole point of this crate.

use borsh::{BorshDeserialize, BorshSerialize};

/// Domain separation tag. Prevents a signature minted for SolMesh from ever being
/// replayed against another protocol, and vice-versa.
pub const STATE_DOMAIN: [u8; 8] = *b"SOLMESH1";

/// The exact bytes both parties sign. `owed_to_provider` is cumulative and
/// monotonically non-decreasing; `nonce` strictly increases by 1 per update.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct StateUpdate {
    pub domain: [u8; 8],
    pub session: [u8; 32],     // session PDA, as raw bytes (Pubkey-agnostic)
    pub nonce: u64,
    pub owed_to_provider: u64,
    pub units_consumed: u64,
    pub timestamp: i64,        // advisory / audit only — never used for on-chain deadlines
}

impl StateUpdate {
    pub fn new(session: [u8; 32], nonce: u64, owed_to_provider: u64, units_consumed: u64, timestamp: i64) -> Self {
        Self { domain: STATE_DOMAIN, session, nonce, owed_to_provider, units_consumed, timestamp }
    }

    /// Deterministic message bytes that get signed.
    pub fn to_message_bytes(&self) -> Vec<u8> {
        let mut data = vec![];
        BorshSerialize::serialize(self, &mut data).expect("borsh serialize StateUpdate");
        data
    }

    pub fn from_message_bytes(data: &[u8]) -> std::io::Result<Self> {
        BorshDeserialize::deserialize(&mut &data[..])
    }

    pub fn has_valid_domain(&self) -> bool {
        self.domain == STATE_DOMAIN
    }
}

#[cfg(feature = "idl-build")]
impl anchor_lang::idl::build::IdlBuild for StateUpdate {
    fn create_type() -> Option<anchor_lang::idl::types::IdlTypeDef> {
        use anchor_lang::idl::types::{
            IdlArrayLen, IdlDefinedFields, IdlField, IdlType, IdlTypeDef, IdlTypeDefTy,
        };
        Some(IdlTypeDef {
            name: "StateUpdate".into(),
            docs: vec![],
            serialization: Default::default(),
            repr: None,
            generics: vec![],
            ty: IdlTypeDefTy::Struct {
                fields: Some(IdlDefinedFields::Named(vec![
                    IdlField {
                        name: "domain".into(),
                        docs: vec![],
                        ty: IdlType::Array(Box::new(IdlType::U8), IdlArrayLen::Value(8)),
                    },
                    IdlField {
                        name: "session".into(),
                        docs: vec![],
                        ty: IdlType::Array(Box::new(IdlType::U8), IdlArrayLen::Value(32)),
                    },
                    IdlField {
                        name: "nonce".into(),
                        docs: vec![],
                        ty: IdlType::U64,
                    },
                    IdlField {
                        name: "owed_to_provider".into(),
                        docs: vec![],
                        ty: IdlType::U64,
                    },
                    IdlField {
                        name: "units_consumed".into(),
                        docs: vec![],
                        ty: IdlType::U64,
                    },
                    IdlField {
                        name: "timestamp".into(),
                        docs: vec![],
                        ty: IdlType::I64,
                    },
                ])),
            },
        })
    }

    fn insert_types(types: &mut std::collections::BTreeMap<String, anchor_lang::idl::types::IdlTypeDef>) {
        if let Some(def) = Self::create_type() {
            types.insert(def.name.clone(), def);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let s = StateUpdate::new([7u8; 32], 3, 1_000, 42, 1_700_000_000);
        let bytes = s.to_message_bytes();
        // 8 + 32 + 8 + 8 + 8 + 8 = 72 bytes, fixed length.
        assert_eq!(bytes.len(), 72);
        assert_eq!(StateUpdate::from_message_bytes(&bytes).unwrap(), s);
    }
}
