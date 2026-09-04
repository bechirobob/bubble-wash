const origin = process.env.BUBBLEWASH_MAINTENANCE_ORIGIN || process.env.BUBBLEWASH_PUBLIC_URL;
const token = process.env.BUBBLEWASH_MAINTENANCE_TOKEN;
if (!origin || !token) throw new Error("BUBBLEWASH_PUBLIC_URL and BUBBLEWASH_MAINTENANCE_TOKEN are required.");
const response = await fetch(`${origin}/api/internal/maintenance`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
const body = await response.text();
if (!response.ok) throw new Error(`Maintenance endpoint returned ${response.status}: ${body.slice(0, 300)}`);
console.log(body);
