use super::*;
use serde_json::json;

#[test]
fn uc_secret_is_distinct_and_environment_switch_drops_only_managed_account() {
    assert_eq!(SECRET, "uc-authorization");
    for local in [false, true] {
        let lease = json!({"source":if local {"local"} else {"managed"}, "provider":"uc","accountId":"fixture"});
        let settings: Settings = serde_json::from_value(json!({"backend":"https://old.invalid/", "authorization_code":"artificial-code", "lease":lease, "saved":{"selected":"old-file"}})).unwrap();
        let normalized = normalize(settings).unwrap();
        assert_eq!(
            normalized.backend,
            crate::config::backend_url().unwrap().to_string()
        );
        assert_eq!(
            normalized.authorization_code.as_deref(),
            Some("artificial-code")
        );
        assert_eq!(normalized.lease.is_some(), local);
        assert_eq!(normalized.saved.is_empty(), !local);
    }
}
