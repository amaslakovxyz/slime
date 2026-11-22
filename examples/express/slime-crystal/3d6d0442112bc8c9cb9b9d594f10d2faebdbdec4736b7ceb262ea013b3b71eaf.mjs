export const sql = "SELECT p.name AS \"plan\", json_agg(json_build_object('name', a.name) ORDER BY a.name) AS \"accounts\" FROM accounts a JOIN plans p ON p.id = a.plan_id WHERE a.country = $1::text GROUP BY p.name ORDER BY p.name";
export const params = ["country"];
export const shape = null;
