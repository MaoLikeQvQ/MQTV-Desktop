use super::*;

fn open_test_database() -> (tempfile::TempDir, Database) {
    let directory = tempfile::tempdir().unwrap();
    let database = Database::open(directory.path().join("app")).unwrap();
    (directory, database)
}

fn encrypted_payload(database: &Database, name: &str) -> Vec<u8> {
    database
        .connection
        .query_row("SELECT payload FROM secrets WHERE name=?1", [name], |row| {
            row.get(0)
        })
        .unwrap()
}

fn image_path(database: &Database, url: &str) -> PathBuf {
    let hash: String = database
        .connection
        .query_row("SELECT hash FROM images WHERE url=?1", [url], |row| {
            row.get(0)
        })
        .unwrap();
    database.root.join("cache/images").join(hash)
}

#[test]
fn settings_and_encrypted_credentials_survive_reopen_without_entering_snapshot() {
    let (_directory, database) = open_test_database();
    let root = database.root.clone();
    database.set("mqtv-history", "[{\"id\":\"film\"}]").unwrap();
    database
        .secret_save("quark-authorization", b"test-cookie-only-for-fixture")
        .unwrap();
    assert_eq!(database.snapshot().unwrap().len(), 1);
    drop(database);

    let reopened = Database::open(root).unwrap();
    assert_eq!(
        reopened.snapshot().unwrap()["mqtv-history"],
        "[{\"id\":\"film\"}]"
    );
    assert_eq!(
        reopened
            .secret_load("quark-authorization")
            .unwrap()
            .unwrap(),
        b"test-cookie-only-for-fixture"
    );
    assert!(
        !reopened
            .snapshot()
            .unwrap()
            .contains_key("quark-authorization")
    );
    assert!(reopened.set("foreign-setting", "ignored").is_err());
}

#[test]
fn browser_migration_preserves_database_values_and_does_not_import_again() {
    let (_directory, mut database) = open_test_database();
    database.set("mqtv-feed-url", "database-url").unwrap();
    let imported = database
        .import(BTreeMap::from([
            ("mqtv-feed-url".into(), "old-browser-url".into()),
            ("mqtv-history".into(), "old-history".into()),
        ]))
        .unwrap();
    assert_eq!(imported["mqtv-feed-url"], "database-url");
    assert_eq!(imported["mqtv-history"], "old-history");
    let second = database
        .import(BTreeMap::from([
            ("mqtv-history".into(), "stale-history".into()),
            ("mqtv-stale-cache".into(), "stale-cache".into()),
        ]))
        .unwrap();
    assert_eq!(second["mqtv-history"], "old-history");
    assert!(!second.contains_key("mqtv-stale-cache"));
}

#[test]
fn invalid_import_is_rejected_before_migration_is_marked_complete() {
    let (_directory, mut database) = open_test_database();
    assert!(
        database
            .import(BTreeMap::from([
                ("mqtv-history".into(), "history".into()),
                ("unrelated-app-key".into(), "private".into()),
            ]))
            .is_err()
    );
    assert!(database.snapshot().unwrap().is_empty());
    let migrated = database
        .import(BTreeMap::from([("mqtv-history".into(), "history".into())]))
        .unwrap();
    assert_eq!(migrated["mqtv-history"], "history");
}

#[test]
fn database_failure_rolls_back_all_imported_values_and_allows_retry() {
    let (_directory, mut database) = open_test_database();
    database
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_import BEFORE INSERT ON settings
        WHEN NEW.key='mqtv-z-fail' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
        )
        .unwrap();
    let entries = BTreeMap::from([
        ("mqtv-a-first".into(), "first".into()),
        ("mqtv-z-fail".into(), "second".into()),
    ]);
    assert!(database.import(entries.clone()).is_err());
    assert!(database.snapshot().unwrap().is_empty());
    database
        .connection
        .execute_batch("DROP TRIGGER fail_import;")
        .unwrap();
    assert_eq!(database.import(entries.clone()).unwrap(), entries);
}

#[test]
fn credentials_use_fresh_authenticated_ciphertext_and_bind_it_to_record_name() {
    let (_directory, database) = open_test_database();
    let fixture = b"test-cookie-and-code-not-real";
    database.secret_save("account-a", fixture).unwrap();
    let first = encrypted_payload(&database, "account-a");
    assert!(!first.windows(fixture.len()).any(|part| part == fixture));
    database.secret_save("account-a", fixture).unwrap();
    let second = encrypted_payload(&database, "account-a");
    assert_ne!(first, second);
    assert_eq!(database.secret_load("account-a").unwrap().unwrap(), fixture);
    database
        .connection
        .execute(
            "INSERT INTO secrets(name,payload) VALUES('account-b',?1)",
            [second],
        )
        .unwrap();
    assert!(database.secret_load("account-b").is_err());
}

#[test]
fn missing_or_wrong_key_never_overwrites_existing_credentials() {
    let (_directory, database) = open_test_database();
    database
        .secret_save("account", b"original-test-cookie")
        .unwrap();
    let original = encrypted_payload(&database, "account");
    let key_path = database.root.join("keys/local.key");
    let key = fs::read(&key_path).unwrap();
    fs::remove_file(&key_path).unwrap();
    assert!(database.secret_load("account").is_err());
    assert!(database.secret_save("account", b"replacement").is_err());
    assert!(database.secret_save("new-account", b"replacement").is_err());
    assert!(!key_path.exists());
    assert_eq!(encrypted_payload(&database, "account"), original);

    let mut wrong_key = key.clone();
    wrong_key[0] ^= 1;
    fs::write(&key_path, wrong_key).unwrap();
    assert!(database.secret_load("account").is_err());
    assert!(database.secret_save("account", b"replacement").is_err());
    assert!(database.secret_save("new-account", b"replacement").is_err());
    assert!(database.secret_load("new-account").unwrap().is_none());
    assert_eq!(encrypted_payload(&database, "account"), original);
    fs::write(key_path, key).unwrap();
    assert_eq!(
        database.secret_load("account").unwrap().unwrap(),
        b"original-test-cookie"
    );
}

#[test]
fn tampered_ciphertext_is_reported_and_not_replaced() {
    let (_directory, database) = open_test_database();
    database
        .secret_save("account", b"original-test-cookie")
        .unwrap();
    let mut payload = encrypted_payload(&database, "account");
    *payload.last_mut().unwrap() ^= 1;
    database
        .connection
        .execute(
            "UPDATE secrets SET payload=?1 WHERE name='account'",
            [&payload],
        )
        .unwrap();
    assert!(database.secret_load("account").is_err());
    assert!(database.secret_save("account", b"replacement").is_err());
    assert_eq!(encrypted_payload(&database, "account"), payload);
}

#[test]
fn newer_schema_is_not_downgraded() {
    let (_directory, database) = open_test_database();
    let root = database.root.clone();
    database.set("mqtv-history", "preserved").unwrap();
    database
        .connection
        .pragma_update(None, "user_version", 2)
        .unwrap();
    drop(database);
    assert!(Database::open(root.clone()).is_err());
    let connection = Connection::open(root.join("mqtv.db")).unwrap();
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM settings WHERE key='mqtv-history'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "preserved"
    );
}

#[test]
fn image_cache_evicts_least_recently_used_and_removes_its_file() {
    let (_directory, mut database) = open_test_database();
    database.write_image("a", b"aaa", "image/png", 6).unwrap();
    database.write_image("b", b"bbb", "image/png", 6).unwrap();
    let old_b = image_path(&database, "b");
    database
        .connection
        .execute_batch("UPDATE images SET accessed=0;")
        .unwrap();
    assert_eq!(database.read_image("a").unwrap().unwrap().bytes, b"aaa");
    database.write_image("c", b"ccc", "image/png", 6).unwrap();
    assert!(database.read_image("b").unwrap().is_none());
    assert!(!old_b.exists());
    assert_eq!(database.read_image("a").unwrap().unwrap().bytes, b"aaa");
    assert_eq!(database.read_image("c").unwrap().unwrap().bytes, b"ccc");
    assert_eq!(
        fs::read_dir(database.root.join("cache/images"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn missing_image_file_is_a_cache_miss_and_corruption_is_an_error() {
    let (_directory, mut database) = open_test_database();
    database
        .write_image("a", b"original", "image/png", 128)
        .unwrap();
    fs::remove_file(image_path(&database, "a")).unwrap();
    assert!(database.read_image("a").unwrap().is_none());
    database
        .write_image("b", b"original", "image/png", 128)
        .unwrap();
    fs::write(image_path(&database, "b"), b"corrupted").unwrap();
    assert!(database.read_image("b").is_err());
}

#[test]
fn shared_image_file_is_retained_while_another_index_references_it() {
    let (_directory, mut database) = open_test_database();
    database.write_image("a", b"same", "image/png", 8).unwrap();
    database.write_image("b", b"same", "image/png", 8).unwrap();
    let shared = image_path(&database, "a");
    database
        .connection
        .execute("UPDATE images SET accessed=0 WHERE url='a'", [])
        .unwrap();
    database.write_image("c", b"next", "image/png", 8).unwrap();
    assert!(database.read_image("a").unwrap().is_none());
    assert!(shared.exists());
    assert_eq!(database.read_image("b").unwrap().unwrap().bytes, b"same");
}

#[test]
fn invalid_or_failed_image_write_does_not_publish_an_index() {
    let (_directory, mut database) = open_test_database();
    assert!(
        database
            .write_image("empty", b"", "image/png", 128)
            .is_err()
    );
    assert!(
        database
            .write_image("wrong-mime", b"body", "text/html", 128)
            .is_err()
    );
    assert!(
        database
            .write_image("too-big", b"body", "image/png", 1)
            .is_err()
    );
    private_dir(&database.root.join("cache")).unwrap();
    fs::write(database.root.join("cache/images"), b"blocking-file").unwrap();
    assert!(
        database
            .write_image("blocked", b"body", "image/png", 128)
            .is_err()
    );
    assert!(database.read_image("blocked").unwrap().is_none());
}

#[test]
fn atomic_file_replacement_leaves_original_on_failure_and_no_temporary_files() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("target");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("preserve"), b"original").unwrap();
    assert!(write_file(&path, b"replacement").is_err());
    assert_eq!(fs::read(path.join("preserve")).unwrap(), b"original");
    assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn database_key_and_cache_files_are_private_to_current_user() {
    use std::os::unix::fs::PermissionsExt;
    let (_directory, mut database) = open_test_database();
    database.secret_save("account", b"test-cookie").unwrap();
    database
        .write_image("image", b"image", "image/png", 128)
        .unwrap();
    for path in [
        database.root.clone(),
        database.root.join("keys"),
        database.root.join("cache/images"),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    for path in [
        database.root.join("mqtv.db"),
        database.root.join("keys/local.key"),
        image_path(&database, "image"),
    ] {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn multi_key_transaction_rolls_back_deletes_and_updates_on_failure() {
    let (_directory, mut database) = open_test_database();
    database.set("mqtv-a-delete", "keep-until-commit").unwrap();
    database.set("mqtv-b-update", "old-value").unwrap();
    database
        .connection
        .execute_batch(
            "CREATE TRIGGER fail_apply BEFORE INSERT ON settings
        WHEN NEW.key='mqtv-z-fail' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;",
        )
        .unwrap();
    let changes = BTreeMap::from([
        ("mqtv-a-delete".into(), None),
        ("mqtv-b-update".into(), Some("new-value".into())),
        ("mqtv-z-fail".into(), Some("new-key".into())),
    ]);
    assert!(database.apply(changes.clone()).is_err());
    let rolled_back = database.snapshot().unwrap();
    assert_eq!(rolled_back["mqtv-a-delete"], "keep-until-commit");
    assert_eq!(rolled_back["mqtv-b-update"], "old-value");
    assert!(!rolled_back.contains_key("mqtv-z-fail"));
    database
        .connection
        .execute_batch("DROP TRIGGER fail_apply;")
        .unwrap();
    database.apply(changes).unwrap();
    let committed = database.snapshot().unwrap();
    assert!(!committed.contains_key("mqtv-a-delete"));
    assert_eq!(committed["mqtv-b-update"], "new-value");
    assert_eq!(committed["mqtv-z-fail"], "new-key");
}

#[test]
fn history_updates_merge_latest_database_and_deletions_preserve_other_movies() {
    let (_dir, db) = open_test_database();
    let movie = |id: &str| serde_json::json!({"id": id, "vod":{"vod_name": id,"vod_pic":"cover"}, "target":{}});
    db.history_update(Some(movie("first")), None).unwrap();
    db.history_update(Some(movie("second")), None).unwrap();
    db.history_update(None, Some("first".into())).unwrap();
    let mut update = movie("second");
    update["vod"]["vod_pic"] = serde_json::json!("");
    let records: Vec<serde_json::Value> =
        serde_json::from_str(&db.history_update(Some(update), None).unwrap()).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["id"], "second");
    assert_eq!(records[0]["vod"]["vod_pic"], "cover");
    // 损坏记录不能被下一次进度写入覆盖。
    db.set("mqtv-playback-history-v1", "{broken").unwrap();
    assert!(db.history_update(Some(movie("third")), None).is_err());
    assert_eq!(
        db.snapshot().unwrap()["mqtv-playback-history-v1"],
        "{broken"
    );
}
