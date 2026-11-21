import tempfile
import unittest

from fastapi.testclient import TestClient

from modeling_agent.api.app import create_app


class ApiContractTests(unittest.TestCase):
    def test_request_models_reject_unknown_fields(self) -> None:
        client = TestClient(create_app())
        route = client.post('/api/v1/agent/route', json={'message': '创建天线', 'unknown': True})
        preview = client.post('/api/v1/agent/modeling/plan', json={'goal': {}, 'unknown': True})
        self.assertEqual(route.status_code, 422)
        self.assertEqual(preview.status_code, 422)
        client.close()

    def test_first_phase_accepts_only_supervised_autonomy(self) -> None:
        client = TestClient(create_app())
        accepted = client.post('/api/v1/agent/runs', json={'message': 'create 2.45 GHz antenna', 'autonomy_level': 'supervised'})
        rejected = client.post('/api/v1/agent/runs', json={'message': 'create 2.45 GHz antenna', 'autonomy_level': 'trusted'})
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(rejected.status_code, 422)
        client.close()

    def test_web_contract_exposes_pending_action_and_cors(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(workflow_mode='langgraph', data_path=f'{directory}/state.json', checkpoint_path=f'{directory}/checkpoints.bin')
            client = TestClient(app)
            created = client.post('/api/v1/agent/runs', json={'project_id': 'web', 'document_id': 'doc', 'user_id': 'u', 'message': 'create 2.45 GHz antenna'}).json()
            resumed = client.post(
                f"/api/v1/agent/runs/{created['id']}/responses",
                json={'request_id': created['waiting_request_id'], 'response': {'antenna_type': 'rectangular_patch'}, 'expected_run_version': created['run_version']},
            )
            self.assertEqual(resumed.status_code, 200)
            payload = client.get(f"/api/v1/agent/runs/{created['id']}").json()
            self.assertEqual(payload['status'], 'waiting_approval')
            self.assertEqual(payload['pending_action']['tool_name'], 'geometry.create_box')
            self.assertEqual(len(payload['actions']), 1)
            self.assertEqual(payload['actions'][0]['status'], 'approval_pending')
            self.assertEqual(payload['progress']['total_actions'], 1)
            self.assertGreaterEqual(payload['progress']['stage_index'], 0)
            cors = client.options('/api/v1/agent/runs', headers={'Origin': 'http://localhost:3000', 'Access-Control-Request-Method': 'POST'})
            self.assertEqual(cors.status_code, 200)
            self.assertEqual(cors.headers.get('access-control-allow-origin'), 'http://localhost:3000')
            client.close()

    def test_request_models_validate_optimistic_version(self) -> None:
        client = TestClient(create_app())
        response = client.post('/api/v1/agent/runs/run-missing/pause', json={'expected_run_version': -1})
        self.assertEqual(response.status_code, 422)
        client.close()

    def test_patch_request_uses_stack_template_and_queues_second_solid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(workflow_mode='langgraph', data_path=f'{directory}/state.json', checkpoint_path=f'{directory}/checkpoints.bin')
            client = TestClient(app)
            created = client.post('/api/v1/agent/runs', json={'project_id': 'web', 'document_id': 'doc', 'user_id': 'u', 'template_id': 'antenna.rectangular_patch_stack', 'message': 'create a 2.45 GHz rectangular patch antenna'}).json()
            self.assertEqual(created['status'], 'waiting_approval')
            first = client.get(f"/api/v1/agent/runs/{created['id']}").json()
            self.assertEqual(first['actions'][0]['arguments']['z_m'], 0.0)
            approved = client.post(
                f"/api/v1/agent/runs/{created['id']}/approvals/{first['waiting_approval_id']}/decision",
                json={'decision': 'approve', 'expected_run_version': first['run_version']},
            )
            self.assertEqual(approved.status_code, 200)
            second = client.get(f"/api/v1/agent/runs/{created['id']}").json()
            self.assertEqual(second['status'], 'completed')
            self.assertEqual(len(second['actions']), 2)
            self.assertEqual(second['actions'][1]['arguments']['z_m'], 0.0016)
            self.assertEqual(second['progress']['total_actions'], 2)
            client.close()

    def test_patch_planner_failure_is_reported_at_planning_stage(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(workflow_mode='langgraph', data_path=f'{directory}/state.json', checkpoint_path=f'{directory}/checkpoints.bin')
            client = TestClient(app)
            created = client.post(
                '/api/v1/agent/runs',
                json={'project_id': 'web', 'document_id': 'doc', 'user_id': 'u', 'message': 'create a 2.45 GHz Patch antenna'},
            ).json()
            self.assertEqual(created['status'], 'failed')
            self.assertEqual(created['current_stage'], 'planning')
            self.assertEqual(created['last_error']['code'], 'PLANNER_REQUIRED')
            self.assertEqual(created['progress']['stage_index'], 3)
            self.assertEqual(created['progress']['total_actions'], 0)
            client.close()


if __name__ == '__main__':
    unittest.main()
