<?php
/** E2E seed：建测试用户 + 批准 device code（argv[1]=user_code）。sqlite 直查。 */
$userCode = $argv[1] ?? exit("usage: php seed_device_user.php <user_code>\n");
$db = new PDO('sqlite:' . ($envDB = getenv('DB_DATABASE') ?: '/tmp/e2e_cli.sqlite'));

$uid = $db->query("select id from users where email='e2e@local.test'")->fetchColumn();
if (!$uid) {
    $uid = '01E2E' . str_pad((string) (time() % 100000000), 20, '0');
    $ins = $db->prepare("insert into users (id, phone, username, nickname, password_hash, email, email_verified, status, level, mcp_enabled, premium_expires_at, invite_code, register_source, created_at, updated_at)
        values (?, 'e2e_seed', 'e2e', 'e2e', ?, 'e2e@local.test', 1, 'active', 'premium', 1, datetime('now', '+7 days'), ?, 'e2e', datetime('now'), datetime('now'))");
    $ins->execute([$uid, password_hash('secret', PASSWORD_DEFAULT), 'E2E' . time()]);
}
$db->exec("update users set level='premium', mcp_enabled=1 where email='e2e@local.test'");
$upd = $db->prepare("update oauth_device_codes set user_id = ?, user_approved_at = datetime('now') where user_code = ?");
$upd->execute([$uid, $userCode]);
echo 'approved_as=' . $uid . ' rows=' . $upd->rowCount() . "\n";
