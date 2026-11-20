extern crate std;

use soroban_sdk::{
    Address, BytesN, Env, IntoVal,
    testutils::{Address as _, MockAuth, MockAuthInvoke},
};

use crate::{AlertRegistry, AlertRegistryArgs, AlertRegistryClient, DataKey, Error};

fn bytes(env: &Env, value: u8) -> BytesN<32> {
    BytesN::from_array(env, &[value; 32])
}

fn fixture() -> (Env, Address, Address) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(AlertRegistry, AlertRegistryArgs::__constructor(&admin));
    (env, admin, contract_id)
}

#[test]
fn constructor_stores_admin_in_instance_storage() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(AlertRegistry, AlertRegistryArgs::__constructor(&admin));

    env.as_contract(&contract_id, || {
        assert_eq!(
            env.storage().instance().get::<_, Address>(&DataKey::Admin),
            Some(admin.clone())
        );
    });
}

#[test]
fn authorized_admin_registers_and_public_reads_need_no_auth() {
    let (env, admin, contract_id) = fixture();
    let client = AlertRegistryClient::new(&env, &contract_id);
    let message_key = bytes(&env, 1);
    let jws_hash = bytes(&env, 2);

    assert_eq!(client.get_alert(&message_key), None);
    env.mock_all_auths();

    assert_eq!(client.register_alert(&message_key, &jws_hash), ());
    assert_eq!(env.auths()[0].0, admin);
    assert_eq!(client.get_alert(&message_key), Some(jws_hash.clone()));
    assert!(client.verify_hash(&message_key, &jws_hash));
    assert!(!client.verify_hash(&message_key, &bytes(&env, 3)));
    assert!(env.auths().is_empty());
}

#[test]
fn duplicate_is_rejected_and_original_hash_remains() {
    let (env, _admin, contract_id) = fixture();
    let client = AlertRegistryClient::new(&env, &contract_id);
    let message_key = bytes(&env, 4);
    let original = bytes(&env, 5);
    let replacement = bytes(&env, 6);
    env.mock_all_auths();

    client.register_alert(&message_key, &original);
    assert_eq!(
        client.try_register_alert(&message_key, &original),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_eq!(
        client.try_register_alert(&message_key, &replacement),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_eq!(client.get_alert(&message_key), Some(original));
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn registration_without_admin_authorization_fails() {
    let (env, _admin, contract_id) = fixture();
    let client = AlertRegistryClient::new(&env, &contract_id);

    client.register_alert(&bytes(&env, 7), &bytes(&env, 8));
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn authorization_from_a_non_admin_address_fails() {
    let (env, _admin, contract_id) = fixture();
    let intruder = Address::generate(&env);
    let message_key = bytes(&env, 9);
    let jws_hash = bytes(&env, 10);
    let client = AlertRegistryClient::new(&env, &contract_id);

    client
        .mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "register_alert",
                args: (&message_key, &jws_hash).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .register_alert(&message_key, &jws_hash);
}
