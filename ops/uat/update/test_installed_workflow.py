from pathlib import Path
import unittest

class WorkflowBoundary(unittest.TestCase):
    def test_installed_workflow_matches_reviewed_template_except_activation(self):
        root=Path(__file__).resolve().parents[3]
        source=(root/'ops/uat/update/uat-update.workflow.template.yml').read_text()
        expected=source.replace('# REVIEW TEMPLATE ONLY. Do not install/dispatch before independent review and approval.','# Explicit dispatch only: approval and quiet-window attestations are mandatory.').replace('name: Guarded isolated UAT update (review draft)','name: Guarded isolated UAT update').replace('    if: false # mandatory draft lock, not a user-toggle',"    if: github.repository == 'bechirobob/bubble-wash' && github.ref == 'refs/heads/main' && inputs.admin_route_approved && inputs.interruption_approved && inputs.quiet_window_coordinated")
        self.assertEqual((root/'.github/workflows/uat-update.yml').read_text(),expected)
