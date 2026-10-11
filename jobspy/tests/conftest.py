import sys
from pathlib import Path

# app.py sits next to tests/: make `import app` work however pytest is invoked.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
