"""Include prepared updater controls in existing restoration CI; no host actions."""
from pathlib import Path
import unittest

def load_tests(loader, tests, pattern):
    return unittest.TestLoader().discover(str(Path(__file__).resolve().parents[1] / 'ops/uat/update'),pattern='test_*.py')
