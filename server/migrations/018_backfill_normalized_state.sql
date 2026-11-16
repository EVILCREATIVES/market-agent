INSERT INTO market_agent_runs (user_id, id, project_id, data, created_at)
SELECT states.user_id,
       run->>'id',
       COALESCE(NULLIF(run->>'projectId', ''), states.state->>'activeProjectId', 'project-default'),
       run,
       COALESCE(NULLIF(run->>'createdAt', '')::timestamptz, NOW())
FROM market_agent_states states
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(states.state->'runs', '[]'::jsonb)) run
WHERE COALESCE(run->>'id', '') <> ''
ON CONFLICT (user_id, id) DO NOTHING;

INSERT INTO market_agent_schedules (user_id, project_id, data, updated_at)
SELECT states.user_id, schedule.key, schedule.value, states.updated_at
FROM market_agent_states states
CROSS JOIN LATERAL jsonb_each(COALESCE(states.state->'schedules', '{}'::jsonb)) schedule
ON CONFLICT (user_id, project_id) DO NOTHING;

INSERT INTO market_agent_project_messages (user_id, project_id, id, data, created_at)
SELECT states.user_id,
       project->>'id',
       message->>'id',
       message,
       COALESCE(NULLIF(message->>'createdAt', '')::timestamptz, NOW())
FROM market_agent_states states
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(states.state->'projects', '[]'::jsonb)) project
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(project->'chatMessages', '[]'::jsonb)) message
WHERE COALESCE(project->>'id', '') <> '' AND COALESCE(message->>'id', '') <> ''
ON CONFLICT (user_id, id) DO NOTHING;
