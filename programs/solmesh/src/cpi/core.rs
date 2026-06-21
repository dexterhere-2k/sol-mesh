//! Thin wrappers around mpl-core CPIs used by SolMesh.
//!
//! NOTE: the exact mpl-core builder API is version specific. These wrappers target
//! mpl-core 0.8.x. If you pin a different version, adjust the builder calls and the
//! plugin enum variants accordingly (see SPEC §12).

use anchor_lang::prelude::*;
use mpl_core::instructions::{CreateV1CpiBuilder, UpdatePluginV1CpiBuilder};
use mpl_core::types::{
    Attribute, Attributes, DataState, Plugin, PluginAuthority, PluginAuthorityPair, UpdateDelegate,
};
use crate::constants::*;

/// Create the node asset with an Attributes plugin (capacity/geo/reputation/total_units)
/// and an UpdateDelegate plugin whose authority is the node PDA, so the program can
/// later mutate reputation without owning the asset.
#[allow(clippy::too_many_arguments)]
pub fn create_node_asset<'info>(
    core_program: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,        // provider
    update_authority: &AccountInfo<'info>, // node PDA (program-owned)
    system_program: &AccountInfo<'info>,
    name: String,
    uri: String,
    capacity: u64,
    geo: String,
    init_reputation: u32,
    node_signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let attributes = Attributes {
        attribute_list: vec![
            Attribute { key: ATTR_CAPACITY.to_string(), value: capacity.to_string() },
            Attribute { key: ATTR_GEO.to_string(), value: geo },
            Attribute { key: ATTR_REPUTATION.to_string(), value: init_reputation.to_string() },
            Attribute { key: ATTR_TOTAL_UNITS.to_string(), value: "0".to_string() },
        ],
    };

    let plugins = vec![
        PluginAuthorityPair {
            plugin: Plugin::Attributes(attributes),
            // Attributes plugin controlled by the node PDA (the program).
            authority: Some(PluginAuthority::UpdateAuthority),
        },
        PluginAuthorityPair {
            plugin: Plugin::UpdateDelegate(UpdateDelegate { additional_delegates: vec![] }),
            authority: Some(PluginAuthority::Address { address: *update_authority.key }),
        },
    ];

    // `data_state` is a required arg on the CreateV1 instruction (mpl-core 0.8.0);
    // AccountState = a regular on-chain asset (not compressed/ledger state).
    CreateV1CpiBuilder::new(core_program)
        .asset(asset)
        .payer(payer)
        .owner(Some(owner))
        .update_authority(Some(update_authority))
        .system_program(system_program)
        .data_state(DataState::AccountState)
        .name(name)
        .uri(uri)
        .plugins(plugins)
        .invoke_signed(node_signer_seeds)?;

    Ok(())
}

/// Overwrite the Attributes plugin with new reputation / total_units values.
/// `update_authority` is the node PDA (program signer).
#[allow(clippy::too_many_arguments)]
pub fn set_reputation<'info>(
    core_program: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    update_authority: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    capacity: u64,
    geo: String,
    reputation: u32,
    total_units: u64,
    node_signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let attributes = Attributes {
        attribute_list: vec![
            Attribute { key: ATTR_CAPACITY.to_string(), value: capacity.to_string() },
            Attribute { key: ATTR_GEO.to_string(), value: geo },
            Attribute { key: ATTR_REPUTATION.to_string(), value: reputation.to_string() },
            Attribute { key: ATTR_TOTAL_UNITS.to_string(), value: total_units.to_string() },
        ],
    };

    UpdatePluginV1CpiBuilder::new(core_program)
        .asset(asset)
        .payer(payer)
        .authority(Some(update_authority))
        .system_program(system_program)
        .plugin(Plugin::Attributes(attributes))
        .invoke_signed(node_signer_seeds)?;

    Ok(())
}
