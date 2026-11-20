#![no_std]

use soroban_sdk::{Address, BytesN, Env, contract, contracterror, contractimpl, contracttype};

#[contract]
pub struct AlertRegistry;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Alert(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyRegistered = 1,
}

#[contractimpl]
impl AlertRegistry {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
    }

    pub fn register_alert(
        env: Env,
        message_key: BytesN<32>,
        jws_hash: BytesN<32>,
    ) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("constructor must store admin");
        admin.require_auth();

        let key = DataKey::Alert(message_key);
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRegistered);
        }

        env.storage().persistent().set(&key, &jws_hash);
        Ok(())
    }

    pub fn get_alert(env: Env, message_key: BytesN<32>) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Alert(message_key))
    }

    pub fn verify_hash(env: Env, message_key: BytesN<32>, jws_hash: BytesN<32>) -> bool {
        Self::get_alert(env, message_key).is_some_and(|stored| stored == jws_hash)
    }
}

#[cfg(test)]
mod test;
