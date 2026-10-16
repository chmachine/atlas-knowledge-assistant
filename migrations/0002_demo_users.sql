-- The five one-click demo users: one per document role, plus an Admin for the audit log and dashboard.
-- Usernames equal the role names so "log in as hr" is literal. All people are fictional.
INSERT OR IGNORE INTO users (id, username, display_name, role, is_admin, is_demo) VALUES
  ('u_employee', 'employee', 'Anna Nowak',        'employee', 0, 1),
  ('u_it_ops',   'it_ops',   'Piotr Kowalczyk',   'it_ops',   0, 1),
  ('u_hr',       'hr',       'Marta Wiśniewska',  'hr',       0, 1),
  ('u_finance',  'finance',  'Tomasz Zieliński',  'finance',  0, 1),
  ('u_admin',    'admin',    'Admin (AI governance)', 'employee', 1, 1);
