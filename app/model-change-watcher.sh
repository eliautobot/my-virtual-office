#!/bin/bash
# model-change-watcher.sh — Handles config change requests from the virtual office
# Supports: set-model, save-key, delete-key, save-custom-provider

STATUS_DIR="${VO_STATUS_DIR:-/tmp/vo-data}"
OPENCLAW_PATH="${VO_OPENCLAW_PATH:-${HOME}/.openclaw}"
REQUEST="$STATUS_DIR/model-change-request.json"
RESULT="$STATUS_DIR/model-change-result.json"
CONFIG="$OPENCLAW_PATH/openclaw.json"
AUTH_PROFILES="$OPENCLAW_PATH/agents/main/agent/auth-profiles.json"

signal_gateway() {
    GW_PID=$(systemctl --user show openclaw-gateway.service --property=MainPID --value 2>/dev/null)
    if [ -n "$GW_PID" ] && [ "$GW_PID" != "0" ]; then
        kill -USR1 "$GW_PID" 2>/dev/null
    fi
}

restart_gateway() {
    # Full restart needed for model changes to apply to active sessions
    systemctl --user restart openclaw-gateway.service 2>/dev/null
}

while true; do
    if [ -s "$REQUEST" ]; then
        REQ_TYPE=$(python3 -c "import json; print(json.load(open('$REQUEST')).get('type',''))" 2>/dev/null)
        
        python3 << 'PYEOF'
import json, sys, os, copy

STATUS_DIR = os.environ.get("VO_STATUS_DIR", "/tmp/vo-data")
OPENCLAW_PATH = os.environ.get("VO_OPENCLAW_PATH", os.path.expanduser("~/.openclaw"))
REQUEST = os.path.join(STATUS_DIR, "model-change-request.json")
RESULT = os.path.join(STATUS_DIR, "model-change-result.json")
CONFIG = os.path.join(OPENCLAW_PATH, "openclaw.json")
AUTH_PROFILES = os.path.join(OPENCLAW_PATH, "agents/main/agent/auth-profiles.json")

def write_result(data):
    with open(RESULT, 'w') as f:
        json.dump(data, f)

try:
    with open(REQUEST) as f:
        req = json.load(f)
    # Truncate instead of remove — file may be root-owned from Docker
    open(REQUEST, 'w').close()
    
    req_type = req.get('type', '')
    
    if req_type == 'set-model':
        agent_id = req['agent_id']
        model_id = req.get('model', '')
        with open(CONFIG) as f:
            cfg = json.load(f)
        found = False
        for a in cfg.get('agents', {}).get('list', []):
            if a['id'] == agent_id:
                if model_id:
                    a['model'] = model_id
                elif 'model' in a:
                    del a['model']
                found = True
                break
        if not found:
            write_result({'ok': False, 'error': f'Agent {agent_id} not found'})
        else:
            with open(CONFIG, 'w') as f:
                json.dump(cfg, f, indent=2)
            write_result({'ok': True, 'agent': agent_id, 'model': model_id or '(default)'})
    
    elif req_type == 'save-key':
        provider = req['provider']
        key = req['key']
        # Read existing auth-profiles
        try:
            with open(AUTH_PROFILES) as f:
                ap = json.load(f)
        except:
            ap = {"version": 1, "profiles": {}, "lastGood": {}}
        
        profile_id = f"{provider}:default"
        ap['profiles'][profile_id] = {
            "type": "api_key",
            "provider": provider,
            "key": key
        }
        ap['lastGood'][provider] = profile_id
        
        with open(AUTH_PROFILES, 'w') as f:
            json.dump(ap, f, indent=2)
        
        # Also add auth profile metadata to openclaw.json
        with open(CONFIG) as f:
            cfg = json.load(f)
        if 'auth' not in cfg:
            cfg['auth'] = {}
        if 'profiles' not in cfg['auth']:
            cfg['auth']['profiles'] = {}
        cfg['auth']['profiles'][profile_id] = {
            "provider": provider,
            "mode": "api_key"
        }
        with open(CONFIG, 'w') as f:
            json.dump(cfg, f, indent=2)
        
        masked = key[:4] + '••••••••' if len(key) > 4 else '****'
        write_result({'ok': True, 'provider': provider, 'maskedKey': masked})
    
    elif req_type == 'delete-key':
        provider = req['provider']
        profile_id = req.get('profileId')
        deleted_profiles = []

        # Remove targeted profile (preferred) or provider default key profile fallback
        try:
            with open(AUTH_PROFILES) as f:
                ap = json.load(f)

            if profile_id:
                to_delete = [profile_id] if profile_id in ap.get('profiles', {}) else []
            else:
                # Legacy fallback: delete only provider:default and provider:api (NOT token/oauth)
                candidates = [f"{provider}:default", f"{provider}:api"]
                to_delete = [k for k in candidates if k in ap.get('profiles', {})]

            for k in to_delete:
                del ap['profiles'][k]
                deleted_profiles.append(k)
                if k in ap.get('usageStats', {}):
                    del ap['usageStats'][k]

            if ap.get('lastGood', {}).get(provider) in deleted_profiles:
                del ap['lastGood'][provider]

            with open(AUTH_PROFILES, 'w') as f:
                json.dump(ap, f, indent=2)
        except:
            pass

        # Mirror profile deletion in openclaw.json auth metadata
        try:
            with open(CONFIG) as f:
                cfg = json.load(f)
            auth_profiles = cfg.get('auth', {}).get('profiles', {})
            for k in deleted_profiles:
                if k in auth_profiles:
                    del auth_profiles[k]
            with open(CONFIG, 'w') as f:
                json.dump(cfg, f, indent=2)
        except:
            pass

        write_result({'ok': True, 'provider': provider, 'deletedProfiles': deleted_profiles})
    
    elif req_type == 'save-custom-provider':
        provider = req['provider']
        base_url = req.get('baseUrl', '')
        models = req.get('models', [])
        
        with open(CONFIG) as f:
            cfg = json.load(f)
        
        if 'models' not in cfg:
            cfg['models'] = {}
        if 'providers' not in cfg['models']:
            cfg['models']['providers'] = {}
        
        existing = cfg['models']['providers'].get(provider, {})
        existing['baseUrl'] = base_url
        if not existing.get('api'):
            existing['api'] = 'openai-completions'
        
        # Build models list preserving existing properties
        old_models = {m['id']: m for m in existing.get('models', [])}
        new_models = []
        for m in models:
            if m['id'] in old_models:
                updated = old_models[m['id']]
                updated['name'] = m.get('name', updated.get('name', m['id']))
                if 'contextWindow' in m:
                    updated['contextWindow'] = m['contextWindow']
                if 'maxTokens' in m:
                    updated['maxTokens'] = m['maxTokens']
                new_models.append(updated)
            else:
                new_models.append({
                    'id': m['id'],
                    'name': m.get('name', m['id']),
                    'reasoning': False,
                    'input': ['text'],
                    'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
                    'contextWindow': m.get('contextWindow', 100000),
                    'maxTokens': m.get('maxTokens', 8192)
                })
        existing['models'] = new_models
        cfg['models']['providers'][provider] = existing
        
        # Save inference params to agents.defaults.models
        params = req.get('params', {})
        if params:
            if 'agents' not in cfg:
                cfg['agents'] = {}
            if 'defaults' not in cfg['agents']:
                cfg['agents']['defaults'] = {}
            if 'models' not in cfg['agents']['defaults']:
                cfg['agents']['defaults']['models'] = {}
            for model_id, model_params in params.items():
                if model_id not in cfg['agents']['defaults']['models']:
                    cfg['agents']['defaults']['models'][model_id] = {}
                cfg['agents']['defaults']['models'][model_id]['params'] = model_params
        
        with open(CONFIG, 'w') as f:
            json.dump(cfg, f, indent=2)
        
        write_result({'ok': True, 'provider': provider, 'modelCount': len(new_models)})
    
    else:
        write_result({'ok': False, 'error': f'Unknown request type: {req_type}'})

except Exception as e:
    write_result({'ok': False, 'error': str(e)})
PYEOF

        # Apply gateway signal after successful change
        if [ -f "$RESULT" ]; then
            OK=$(python3 -c "import json; print(json.load(open('$RESULT')).get('ok', False))" 2>/dev/null)
            if [ "$OK" = "True" ]; then
                if [ "$REQ_TYPE" = "set-model" ]; then
                    # Full restart needed — model change must apply to active sessions
                    restart_gateway
                else
                    signal_gateway
                fi
            fi
        fi
    fi
    sleep 0.5
done
