//! Is a program immutable? Zero custody rests on nobody being able to change the code that decides
//! who a vault pays, so the router registers only immutable implementations and verifiers, and a
//! verifier accepts only an immutable proof-system program behind it. Solana has had four loaders;
//! each records immutability differently, and this reads all of them.
use anchor_lang::prelude::*;

pub const BPF_LOADER_UPGRADEABLE: Pubkey = Pubkey::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");
pub const BPF_LOADER_2: Pubkey = Pubkey::from_str_const("BPFLoader2111111111111111111111111111111111");
pub const BPF_LOADER_1: Pubkey = Pubkey::from_str_const("BPFLoader1111111111111111111111111111111111");
pub const LOADER_V4: Pubkey = Pubkey::from_str_const("LoaderV411111111111111111111111111111111111");
pub const NATIVE_LOADER: Pubkey = Pubkey::from_str_const("NativeLoader1111111111111111111111111111111");

/// `UpgradeableLoaderState::Program` is bincode: u32 tag 2, then the ProgramData address.
const UPGRADEABLE_PROGRAM_TAG: u32 = 2;
const UPGRADEABLE_PROGRAM_LEN: usize = 4 + 32;
/// `UpgradeableLoaderState::ProgramData`: u32 tag 3, u64 slot, Option<Pubkey> upgrade authority
/// (one byte, 0 = None), then the program bytes.
const UPGRADEABLE_PROGRAM_DATA_TAG: u32 = 3;
const UPGRADEABLE_AUTHORITY_OFFSET: usize = 4 + 8;
/// `LoaderV4State { slot: u64, authority_address_or_next_version: Pubkey, status: u64 }`.
const LOADER_V4_STATUS_OFFSET: usize = 8 + 32;
const LOADER_V4_FINALIZED: u64 = 2;

/// The ProgramData account of a program deployed with the upgradeable loader.
pub fn program_data_address(program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program.as_ref()], &BPF_LOADER_UPGRADEABLE).0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramStatus {
    /// Deployed and nobody can change it.
    Immutable,
    /// Deployed with an authority that can replace its code.
    Upgradeable,
    /// Not an executable account of a known loader.
    NotExecutable,
    /// The upgradeable loader needs the program's ProgramData account; this is not it.
    WrongProgramData,
}

/// `program_data` is the program's ProgramData account when it was deployed with the upgradeable
/// loader (`program_data_address`); for the other loaders the program account says it all and any
/// account may be passed.
pub fn program_status(program: &AccountInfo, program_data: Option<&AccountInfo>) -> ProgramStatus {
    if !program.executable {
        return ProgramStatus::NotExecutable;
    }
    let owner = *program.owner;
    if owner == BPF_LOADER_UPGRADEABLE {
        let Ok(data) = program.try_borrow_data() else { return ProgramStatus::NotExecutable };
        if data.len() < UPGRADEABLE_PROGRAM_LEN || data[..4] != UPGRADEABLE_PROGRAM_TAG.to_le_bytes() {
            return ProgramStatus::NotExecutable;
        }
        let expected = Pubkey::new_from_array(data[4..UPGRADEABLE_PROGRAM_LEN].try_into().unwrap());
        let Some(program_data) = program_data else { return ProgramStatus::WrongProgramData };
        if *program_data.key != expected || *program_data.owner != BPF_LOADER_UPGRADEABLE {
            return ProgramStatus::WrongProgramData;
        }
        let Ok(state) = program_data.try_borrow_data() else { return ProgramStatus::WrongProgramData };
        if state.len() <= UPGRADEABLE_AUTHORITY_OFFSET || state[..4] != UPGRADEABLE_PROGRAM_DATA_TAG.to_le_bytes() {
            return ProgramStatus::WrongProgramData;
        }
        return if state[UPGRADEABLE_AUTHORITY_OFFSET] == 0 {
            ProgramStatus::Immutable
        } else {
            ProgramStatus::Upgradeable
        };
    }
    if owner == LOADER_V4 {
        let Ok(data) = program.try_borrow_data() else { return ProgramStatus::NotExecutable };
        let Some(status) = data.get(LOADER_V4_STATUS_OFFSET..LOADER_V4_STATUS_OFFSET + 8) else {
            return ProgramStatus::NotExecutable;
        };
        return if u64::from_le_bytes(status.try_into().unwrap()) == LOADER_V4_FINALIZED {
            ProgramStatus::Immutable
        } else {
            ProgramStatus::Upgradeable
        };
    }
    if owner == BPF_LOADER_2 || owner == BPF_LOADER_1 || owner == NATIVE_LOADER {
        // These loaders never had an upgrade path.
        return ProgramStatus::Immutable;
    }
    ProgramStatus::NotExecutable
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Raw {
        key: Pubkey,
        owner: Pubkey,
        lamports: u64,
        data: Vec<u8>,
        executable: bool,
    }

    impl Raw {
        fn info(&mut self) -> AccountInfo<'_> {
            AccountInfo::new(&self.key, false, false, &mut self.lamports, &mut self.data, &self.owner, self.executable)
        }
    }

    fn upgradeable_pair(authority: Option<Pubkey>) -> (Raw, Raw) {
        let program = Pubkey::new_unique();
        let pd_key = program_data_address(&program);
        let mut program_data = vec![];
        program_data.extend_from_slice(&UPGRADEABLE_PROGRAM_TAG.to_le_bytes());
        program_data.extend_from_slice(pd_key.as_ref());
        let mut state = vec![];
        state.extend_from_slice(&UPGRADEABLE_PROGRAM_DATA_TAG.to_le_bytes());
        state.extend_from_slice(&7u64.to_le_bytes());
        match authority {
            Some(a) => {
                state.push(1);
                state.extend_from_slice(a.as_ref());
            }
            None => {
                state.push(0);
                state.extend_from_slice(&[0; 32]);
            }
        }
        state.extend_from_slice(&[0xAA; 16]);
        (
            Raw { key: program, owner: BPF_LOADER_UPGRADEABLE, lamports: 1, data: program_data, executable: true },
            Raw { key: pd_key, owner: BPF_LOADER_UPGRADEABLE, lamports: 1, data: state, executable: false },
        )
    }

    #[test]
    fn upgradeable_loader_reads_the_authority() {
        let (mut p, mut pd) = upgradeable_pair(None);
        assert_eq!(program_status(&p.info(), Some(&pd.info())), ProgramStatus::Immutable);
        let (mut p, mut pd) = upgradeable_pair(Some(Pubkey::new_unique()));
        assert_eq!(program_status(&p.info(), Some(&pd.info())), ProgramStatus::Upgradeable);
        assert_eq!(program_status(&p.info(), None), ProgramStatus::WrongProgramData);
        let (_, mut other) = upgradeable_pair(None);
        assert_eq!(program_status(&p.info(), Some(&other.info())), ProgramStatus::WrongProgramData);
        p.executable = false;
        assert_eq!(program_status(&p.info(), Some(&pd.info())), ProgramStatus::NotExecutable);
    }

    #[test]
    fn loader_v4_reads_the_status() {
        let mut data = vec![0u8; 48 + 8];
        data[LOADER_V4_STATUS_OFFSET..LOADER_V4_STATUS_OFFSET + 8].copy_from_slice(&LOADER_V4_FINALIZED.to_le_bytes());
        let mut p = Raw { key: Pubkey::new_unique(), owner: LOADER_V4, lamports: 1, data, executable: true };
        assert_eq!(program_status(&p.info(), None), ProgramStatus::Immutable);
        p.data[LOADER_V4_STATUS_OFFSET] = 1;
        assert_eq!(program_status(&p.info(), None), ProgramStatus::Upgradeable);
    }

    #[test]
    fn legacy_loaders_are_immutable_and_others_are_not_programs() {
        let mut p = Raw { key: Pubkey::new_unique(), owner: BPF_LOADER_2, lamports: 1, data: vec![1, 2, 3], executable: true };
        assert_eq!(program_status(&p.info(), None), ProgramStatus::Immutable);
        p.owner = Pubkey::new_unique();
        assert_eq!(program_status(&p.info(), None), ProgramStatus::NotExecutable);
    }
}
