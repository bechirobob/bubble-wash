"""One read-only diagnosis, loaded after unchanged preflight read helpers."""
ATTEMPT_SHA = '1406b0e217ed02709ebe1c423aecb42c6be5b0aa'
ATTEMPT_DIR = Path('/home/ubuntu/bubblewash-releases/20261102T173612Z-1406b0e217ed')
ATTEMPT_FROZEN = Path('/var/lib/bubblewash-release/releases') / ATTEMPT_SHA
ATTEMPT_EVIDENCE = Path('/var/lib/bubblewash-release/rehearsal-evidence') / ('pwa-' + ATTEMPT_SHA)
ATTEMPT_UNIT = 'bubblewash-pwa-update-20261102T173612Z-1406b0e217ed'
ATTEMPT_CONTENT = '41b9ac07bc578fae3c2e77b5f4099a818e99c8f74aad52ac57bb8e65a1147c2d'
ATTEMPT_GENERATED = frozenset(('.git', '.next', 'node_modules', '.npm', 'data', '.release-sha', 'next-env.d.ts', 'tsconfig.tsbuildinfo'))
ATTEMPT_EXCLUDED = frozenset(('tooling/next-eslint-glob/node_modules', 'tooling/minimatch-compat/node_modules'))


def attempt_directory(path):
    fd = retained_open(None, '/', True)
    try:
        for part in path.parts[1:]:
            child = retained_open(fd, part, True)
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def attempt_kind(parent, name):
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        return 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'other'
    except FileNotFoundError:
        return 'missing'


def attempt_names(parent):
    fd = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NOATIME, dir_fd=parent)
    try:
        names = os.listdir(fd)
        if len(names) > 2048:
            raise ValueError('inventory bound exceeded')
        return sorted(names)
    finally:
        os.close(fd)


def attempt_commitment(expected):
    dirs = sorted({str(p) for name in expected for p in Path(name).parents if p != Path('.')})
    rows = [('d', name) for name in dirs] + [('f', name, expected[name]) for name in sorted(expected)]
    return hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()


def attempt_snapshot(fd, expected):
    children = {}
    for name in expected:
        parts = name.split('/')
        for index, child in enumerate(parts):
            children.setdefault('/'.join(parts[:index]), set()).add(child)
    mismatches, extras, inventory = [], [], []
    observed = 0
    def visit(parent, relative=''):
        nonlocal observed
        names = attempt_names(parent)
        observed += len(names)
        if observed > 8192: raise ValueError('inventory bound exceeded')
        inventory.append((relative, names))
        for child in names:
            name = relative + '/' + child if relative else child
            if name in ATTEMPT_EXCLUDED or (not relative and child in ATTEMPT_GENERATED):
                continue
            if child not in children.get(relative, set()):
                row = {'kind': attempt_kind(parent, child)}
                if name == '.config': row['path'] = name
                else: row['pathSha256'] = hashlib.sha256(name.encode()).hexdigest()
                extras.append(row)  # Never read unknown content or emit unknown names.
                if len(extras) > 128: raise ValueError('extra-entry bound exceeded')
        for child in sorted(children.get(relative, set())):
            name = relative + '/' + child if relative else child
            kind = attempt_kind(parent, child)
            if name in expected:
                if kind != 'file':
                    mismatches.append({'path': name, 'classification': kind})
                    continue
                try:
                    digest = hashlib.sha256(retained_read(parent, child, 32 * 1024 * 1024)).hexdigest()
                    inventory.append((name, digest))
                    if digest != expected[name]:
                        mismatches.append({'path': name, 'expectedSha256': expected[name], 'actualSha256': digest})
                except (OSError, ValueError):
                    mismatches.append({'path': name, 'classification': 'unreadable-or-unstable'})
            elif kind != 'directory':
                mismatches.append({'path': name, 'classification': kind})
            else:
                sub = retained_open(parent, child, True)
                try: visit(sub, name)
                finally: os.close(sub)
    visit(fd)
    result = {'trackedSourceMismatches': mismatches, 'unexpectedSourceEntries': extras}
    return result, hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()


def attempt_metadata(path, names):
    try: fd = attempt_directory(path)
    except FileNotFoundError: return {'directory': 'missing'}
    except OSError: return {'directory': 'unavailable-or-unsafe'}
    try: return {'directory': 'present', 'entries': {name: attempt_kind(fd, name) for name in names}}
    finally: os.close(fd)


def inspect_workspace_attempt(expected):
    result = {'readOnly': True, 'runId': '41492657040', 'attempt': 1,
              'switchHistoryProven': False, 'missingUnitsDoNotProveNeverRan': True,
              'deploymentOwnershipAndModeGuardsVerified': False}
    fd = None
    try:
        if attempt_commitment(expected) != ATTEMPT_CONTENT:
            raise ValueError('unexpected source map')
        fd = attempt_directory(ATTEMPT_DIR)
        marker = retained_read(fd, '.release-sha', 41)
        if marker not in (ATTEMPT_SHA.encode(), (ATTEMPT_SHA + '\n').encode()):
            raise ValueError('candidate pin mismatch')
        root_identity = os.fstat(fd)
        first, identity = attempt_snapshot(fd, expected)
        second, repeated = attempt_snapshot(fd, expected)
        if first != second or identity != repeated or retained_read(fd, '.release-sha', 41) != marker:
            raise ValueError('source changed during inspection')
        current_fd = attempt_directory(ATTEMPT_DIR)
        try:
            current_identity = os.fstat(current_fd)
            if (root_identity.st_dev, root_identity.st_ino) != (current_identity.st_dev, current_identity.st_ino):
                raise ValueError('candidate directory replaced')
        finally: os.close(current_fd)
        result.update(first)
        result['sourceInventoryStableDuringRead'] = True
        result['sourceInventoryMatches'] = not first['trackedSourceMismatches'] and not first['unexpectedSourceEntries']
        result['nextConfig'] = attempt_metadata(ATTEMPT_DIR / '.config', ('nextjs-nodejs',))
        try:
            raw = retained_read(fd, '.next/BUILD_ID', 129)
            result['buildId'] = {'present': True, 'sha256': hashlib.sha256(raw).hexdigest()}
        except (OSError, ValueError): result['buildId'] = {'present': False}
        result['frozenRelease'] = attempt_metadata(ATTEMPT_FROZEN, ('.release-sha', '.next', 'node_modules'))
        result['freezeEvidence'] = attempt_metadata(ATTEMPT_EVIDENCE, (ATTEMPT_SHA + '.tar', ATTEMPT_SHA + '-manifest.json'))
        units = {}
        for label, suffix in (('build', '-build.service'), ('rollbackProbe', '-rollback-probe.service'), ('candidateProbe', '-candidate-probe.service')):
            try:
                raw = command(['systemctl', 'show', ATTEMPT_UNIT + suffix, '--property=LoadState,ActiveState,SubState,Result'])
                values = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
                allowed = {'loaded', 'not-found', 'active', 'inactive', 'failed', 'dead', 'running', 'exited', 'success', 'exit-code', 'signal', 'timeout', 'start-limit-hit', 'resources', 'condition', 'assert', ''}
                units[label] = {key: value if value in allowed else 'other' for key, value in values.items() if key in ('LoadState', 'ActiveState', 'SubState', 'Result')}
            except Exception: units[label] = {'inspectionSupported': False}
        result['exactAttemptUnits'] = units
        result['inspectionFailed'] = False
        return result
    except Exception:
        return {**result, 'inspectionFailed': True}
    finally:
        if fd is not None: os.close(fd)
