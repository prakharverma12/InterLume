"""
Export RIFE to ONNX without ensemble (faster inference).

The models currently used by SmoothSlomo are exported with ensemble=True, which runs
the model twice (forward + backward pass) and averages the result. This doubles the
operator count and GPU dispatch count, which is the bottleneck on older hardware.

This script exports the same model weights with ensemble=False, cutting inference time
roughly in half with negligible quality difference (the original authors removed ensemble
from v4.7+ as standard practice).

QUICK START
-----------
1. Install dependencies:
       pip install torch torchvision onnx onnxsim requests

2. Clone Practical-RIFE:
       git clone https://github.com/hzwer/Practical-RIFE
       cd Practical-RIFE

3. Download weights — pick ONE:
     - v4.26 lite (fastest, good quality):
         https://drive.google.com/file/d/1zlKblGuKNatulJNFf5jdB-emp9AqGK05
     - v4.26 (best quality):
         https://drive.google.com/file/d/1gViYvvQrtETBgU1w8axZSsr7YUuw31uy
     - v4.22 lite:
         https://drive.google.com/file/d/1Smy6gY7BkS_RzCjPCbMEy-TsX8Ma5B0R
     Extract the downloaded archive so that train_log/flownet.pkl exists.

4. Copy this script into the Practical-RIFE directory and run:
       python export_rife_no_ensemble.py --version 4.26_lite

5. Upload the resulting .onnx file to HuggingFace (or put in public/models/).
   Update MODEL_URLS in src/lib/modelStore.js to point at it.

EXPECTED SPEEDUP
----------------
Removing ensemble halves the operator count and thus halves the WebGPU dispatch count.
On the AMD GCN-5 at ~10 ms/dispatch overhead (100+ dispatches):
  Before: ~1000 ms/pair (ensemble=True)
  After:  ~500  ms/pair (ensemble=False)

Using a lite model additionally reduces parameters by ~50%, further cutting dispatch count:
  Lite + no ensemble: ~250-350 ms/pair (estimated)
"""

import argparse
import os
import sys
import torch
import torch.nn as nn

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
parser = argparse.ArgumentParser(description='Export RIFE to ONNX without ensemble')
parser.add_argument('--version', default='4.26_lite',
                    help='Model version string, e.g. 4.26_lite, 4.26, 4.22_lite')
parser.add_argument('--weights', default='train_log/flownet.pkl',
                    help='Path to flownet.pkl weights file')
parser.add_argument('--output', default=None,
                    help='Output .onnx path (default: rife_v{version}_no_ensemble.onnx)')
parser.add_argument('--opset', type=int, default=17,
                    help='ONNX opset version (default: 17)')
parser.add_argument('--no-simplify', action='store_true',
                    help='Skip onnx-simplifier step')
args = parser.parse_args()

version_str = args.version
weights_path = args.weights
output_path = args.output or f'rife_v{version_str}_no_ensemble.onnx'
opset = args.opset

# ---------------------------------------------------------------------------
# Locate Practical-RIFE model directory
# ---------------------------------------------------------------------------
script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, script_dir)

# ---------------------------------------------------------------------------
# Load Practical-RIFE model
# ---------------------------------------------------------------------------
print(f'Loading model (version {version_str}) from {weights_path} ...')

if not os.path.exists(weights_path):
    print(f'\nERROR: weights file not found: {weights_path}')
    print('Download weights from Practical-RIFE README (Google Drive links)')
    sys.exit(1)

# Try the standard Practical-RIFE Model class
try:
    from model.RIFE_HDv3 import Model
    model = Model()
    model.load_model(weights_path.replace('/flownet.pkl', '').replace('\\flownet.pkl', ''), -1)
    flownet = model.flownet
    print('Loaded via model.RIFE_HDv3.Model')
except Exception as e1:
    try:
        from model.RIFE import Model
        model = Model()
        model.load_model(weights_path.replace('/flownet.pkl', '').replace('\\flownet.pkl', ''), -1)
        flownet = model.flownet
        print('Loaded via model.RIFE.Model')
    except Exception as e2:
        # Last resort: load IFNet directly
        try:
            from model.IFNet_HDv3 import IFNet
            flownet = IFNet()
            state = torch.load(weights_path, map_location='cpu')
            # Strip 'module.' prefix if present (DDP checkpoint)
            state = {k.replace('module.', ''): v for k, v in state.items()}
            flownet.load_state_dict(state, strict=False)
            print('Loaded via model.IFNet_HDv3.IFNet (direct)')
        except Exception as e3:
            print('\nERROR: Could not load model. Tried:')
            print(f'  model.RIFE_HDv3.Model: {e1}')
            print(f'  model.RIFE.Model: {e2}')
            print(f'  model.IFNet_HDv3.IFNet: {e3}')
            print('\nMake sure you are running this script from inside the Practical-RIFE directory.')
            sys.exit(1)

flownet.eval()
print('Model loaded successfully.')


# ---------------------------------------------------------------------------
# Wrapper: fix ensemble=False and scale=1.0
# ---------------------------------------------------------------------------
class RIFENoEnsemble(nn.Module):
    """
    Wraps the RIFE IFNet (flownet) to:
      - Fix ensemble=False  (remove the extra backward pass that doubles dispatch count)
      - Fix scale=1.0       (bake in scale, same as current yuvraj108c models)

    Inputs:
      img0      [1, 3, H, W]  float32, values in [0, 1]
      img1      [1, 3, H, W]  float32, values in [0, 1]
      timestep  [1]           float32, value in [0, 1]  (e.g. 0.5 for midpoint)

    Output:
      merged    [1, 3, H, W]  float32, values in [0, 1]
    """
    def __init__(self, ifnet: nn.Module):
        super().__init__()
        self.ifnet = ifnet

    def forward(self, img0: torch.Tensor, img1: torch.Tensor, timestep: torch.Tensor):
        # The forward() call signature may vary slightly across Practical-RIFE versions.
        # We try the most common form first, then fall back.
        try:
            return self.ifnet(img0, img1, timestep, scale=1.0, ensemble=False)
        except TypeError:
            # Older versions without 'ensemble' kwarg — just scale
            return self.ifnet(img0, img1, timestep, scale=1.0)


model_wrapper = RIFENoEnsemble(flownet)
model_wrapper.eval()


# ---------------------------------------------------------------------------
# ONNX export
# ---------------------------------------------------------------------------
H, W = 256, 256  # Dummy size; dynamic axes make the actual size irrelevant
img0 = torch.zeros(1, 3, H, W)
img1 = torch.zeros(1, 3, H, W)
timestep = torch.tensor([0.5])  # Shape [1] — scalar timestep

raw_path = output_path.replace('.onnx', '_raw.onnx')

print(f'\nExporting to ONNX (opset {opset}) ...')
with torch.no_grad():
    torch.onnx.export(
        model_wrapper,
        (img0, img1, timestep),
        raw_path,
        input_names=['img0', 'img1', 'timestep'],
        output_names=['output'],
        opset_version=opset,
        dynamic_axes={
            'img0':   {0: 'batch', 2: 'height', 3: 'width'},
            'img1':   {0: 'batch', 2: 'height', 3: 'width'},
            'output': {0: 'batch', 2: 'height', 3: 'width'},
        },
    )
print(f'Raw ONNX written: {raw_path}  ({os.path.getsize(raw_path)/1024/1024:.1f} MB)')


# ---------------------------------------------------------------------------
# Optional: onnx-simplifier (fuses ops, reduces graph size & dispatch count)
# ---------------------------------------------------------------------------
if not args.no_simplify:
    try:
        import onnx
        from onnxsim import simplify as onnx_simplify

        print('Running onnx-simplifier ...')
        raw_model = onnx.load(raw_path)
        simplified, ok = onnx_simplify(raw_model)
        if ok:
            onnx.save(simplified, output_path)
            print(f'Simplified ONNX written: {output_path}  ({os.path.getsize(output_path)/1024/1024:.1f} MB)')
            os.remove(raw_path)
        else:
            print('WARNING: onnx-simplifier could not simplify — using raw export.')
            os.rename(raw_path, output_path)
    except ImportError:
        print('onnxsim not installed — skipping simplification (pip install onnxsim)')
        os.rename(raw_path, output_path)
else:
    os.rename(raw_path, output_path)

final_mb = os.path.getsize(output_path) / 1024 / 1024
print(f'\nDone! {output_path} ({final_mb:.1f} MB)')

# ---------------------------------------------------------------------------
# Verify: check operator count
# ---------------------------------------------------------------------------
try:
    import onnx
    m = onnx.load(output_path)
    op_types = {}
    for n in m.graph.node:
        op_types[n.op_type] = op_types.get(n.op_type, 0) + 1
    total_nodes = len(m.graph.node)
    print(f'\nONNX graph: {total_nodes} nodes (vs ~{total_nodes*2} expected in ensemble model)')
    print(f'Top ops: {sorted(op_types.items(), key=lambda x: -x[1])[:8]}')
except ImportError:
    pass

print("""
NEXT STEPS
----------
1. Upload to HuggingFace (or put in project public/models/):
     huggingface-cli upload YOUR_HF_USERNAME/rife-onnx rife_v{}_no_ensemble.onnx

2. Update src/lib/modelStore.js:
     export const MODEL_URLS = {{
       'rife_fp16.onnx': 'https://huggingface.co/YOUR_HF_USERNAME/rife-onnx/resolve/main/rife_v{}_no_ensemble.onnx',
       'rife_int8.onnx': 'https://huggingface.co/YOUR_HF_USERNAME/rife-onnx/resolve/main/rife_v{}_lite_no_ensemble.onnx',
     }}

3. Clear your browser's IndexedDB cache (cached models section in the app UI)
   so it re-downloads the new model files.
""".format(version_str, version_str, version_str.replace('_lite', '')))
