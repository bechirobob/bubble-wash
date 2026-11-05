"""Operation-specific validation; original owner contract stays unchanged."""
import base64
import hashlib
import json
import re
owner = pins = None
OPERATION = 'expired-owner-to-administrator'
PURPOSE = 'bubblewash-administrator-transition/v1'
NODE_SHA256 = '81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90'
def require(value):
    if not value: raise ValueError('administrator contract refused')
def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def public_der(value): return owner.public_der(value)
def validate(request):
    require(type(request) is dict and request.get('operation') == OPERATION)
    require(request.get('recipient') == {'email':'abigail@bubblewash.co','name':'Abigail Kabirou'})
    owner.pins = pins
    owner.validate({k:v for k,v in request.items() if k != 'operation'})
    return request
def context(request): return {**owner.context(request),'operation':OPERATION}
def envelope(raw, request):
    require(0 < len(raw) <= 16384); value=json.loads(raw)
    require(type(value) is dict and set(value)=={'schema','context','keySha256','wrappedKey','iv','tag','ciphertext'})
    require(value['schema']==PURPOSE and value['context']==context(request) and
        value['keySha256']==hashlib.sha256(public_der(request['publicKey'])).hexdigest() and canonical(value)==raw)
    for name,length in (('wrappedKey',384),('iv',12),('tag',16),('ciphertext',None)):
        require(type(value[name]) is str); data=base64.b64decode(value[name],validate=True)
        require(base64.b64encode(data).decode()==value[name] and (len(data)==length if length else 0<len(data)<8192))
    return value
