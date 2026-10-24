"""Read-only classification of the retained failed preparation, never acceptance."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import time

REQUEST = {'backupSha256': 'a31c997b06c6b00a62ce8fa93874818445c3f1de07f775439e30d0668c945e02', 'receiptRun': '40140104543', 'storeSha': '2fe787ae243bb8eb82827e224be87ed00796fccc', 'storeId': 1403152795, 'node': {'path': '/usr/bin/node', 'sha256': '81925c0995b5c1427b5d538e6a90ca2fdc4daffb786b09af749beaf7369d4e90'}, 'runId': '40140299227', 'runAttempt': 1, 'candidateSha': '5f256800d65dbe3b69f54e95afa0e8ab30b5e881', 'fallbackSha': '80ec00902fcc5fe16a17ab814c7d191ad44afb64'}
PACKAGE = '391efcd7c9d7d7985b62d760d54e780629dac80bde713fa811e7b7b32537f429'
CONTRACT_SHA = '01dfe3eaf49ae51e155eaf1c9e77f2c5d0d892969c82290771412710f9c4c493'
CONTRACT = {'baseCommit': '5dc997db0393e1cf88dde29859b7e1c4550ee4ee', 'controlDependencies': {'ops/inactive-staging/prepare_pair.py': '6f1859a34013f593d21dbd283eac05748eb6c61be2440319a50a9437c42025bd'}, 'controlRunner': {'contentSha256': 'b5441a5a0a0877e0a34f9fe3af4e53d71da27b7e074f0e84f0f0d61c2c00063a', 'files': 484, 'schema': 'bubblewash-control-runner/v1'}, 'ownerFiles': {'src/lib/admin-mfa.ts': '15c78716d909d298542ce777d98b8d2dae5f67a8327aa427117f9656b6dcf4f5', 'src/lib/auth.ts': '470f0b92c371b20a88ef831f537732006d370ac02c7de9ca0727a90716f4cc81', 'src/lib/staff-accounts.ts': 'e2986ffd74a9d007a8489dc068bba9a7bcbdfd30f39b2a681c0a65c54e20960e'}, 'profiles': {'integration-candidate-v1': {'appInputGitTree': '0076161b49d587787472f8c9128c6f261eedc72e', 'contentSha256': '926109a11b123ddaacd7fca6083937c2d3f89c61df9f47ea9a74b7b0e0307ec7', 'publicationCommit': '5f256800d65dbe3b69f54e95afa0e8ab30b5e881', 'rootFiles': ['.env.production.example', '.gitignore', 'DESIGN.md', 'README.md', 'eslint.config.mjs', 'next.config.mjs', 'package-lock.json', 'package.json', 'playwright.config.mjs', 'playwright.worklists.config.mjs', 'tsconfig.json']}, 'integration-fallback-v1': {'appInputGitTree': 'c90fe5e836022d8084d0f8f936e5d00bb8522be6', 'contentSha256': '638c7e6f5524b18a62484cbdf614b2e2df4e0df4e4045122ccc53fc9a722bee2', 'publicationCommit': '80ec00902fcc5fe16a17ab814c7d191ad44afb64', 'rootFiles': ['.env.production.example', '.gitignore', 'DESIGN.md', 'README.md', 'eslint.config.mjs', 'next.config.mjs', 'package-lock.json', 'package.json', 'playwright.config.mjs', 'tsconfig.json']}}, 'schema': 'bubblewash-integration-source/v2'}
CATEGORIES = ('IDENTITY','PACKAGE_CONTRACT','LOCK','CURRENT_POINTER','CURRENT_MARKER','RELEASE_MARKER',
 'SOURCE_TREE','SOURCE_COMMITMENT','ENVIRONMENT_METADATA','ENVIRONMENT_PARSE','SURVEY_CONFIGURATION','PRODUCTION_CONFIGURATION',
 'AUTOMATED_UPDATES_DISABLED','DATABASE_LOCATION','DATABASE_METADATA','BACKUP_RECEIPT','ARCHIVE_BINDING','BACKUP_VERIFICATION','NODE_PIN',
 'RUNTIME_FLAGS','RUNTIME_HEALTH','CONTRACT_RECHECK','POINTER_RECHECK','SOURCE_RECHECK','ENVIRONMENT_RECHECK',
 'DATABASE_RECHECK','RECEIPT_RECHECK','NODE_RECHECK','LOCK_RECHECK')


def inspect_archive(path, owner_uid, expected_size, expected_sha):
    """Inspect only the expected encrypted archive; never return paths or bytes."""
    import stat
    path = Path(path)
    report = {'absolute':path.is_absolute(),'canonical':False,'exportDirectoryMatch':path.parent==Path('/home/ubuntu/bubblewash-backups/github-staging'),'ancestors':[],
              'leaf':{'present':False},'expectedSize':expected_size,'sizeMatch':False,'hashMatch':'not-run','stable':'not-run'}
    if not report['absolute'] or len(path.parts)>32:
        return report
    try:
        report['canonical'] = path.resolve(strict=True)==path
    except (OSError, RuntimeError):
        pass
    safe_chain = True
    for depth, parent in enumerate(reversed(path.parents)):
        try:
            info = parent.lstat()
            row = {'depth':depth,'present':True,'directory':stat.S_ISDIR(info.st_mode),
                   'uid':info.st_uid,'gid':info.st_gid,'mode':stat.S_IMODE(info.st_mode),
                   'device':info.st_dev,'inode':info.st_ino,'symlink':stat.S_ISLNK(info.st_mode),
                   'ownerAllowed':info.st_uid in (0,owner_uid),'writeProtected':not bool(info.st_mode & 0o022)}
            safe_chain = safe_chain and row['directory'] and row['ownerAllowed']
            report['ancestors'].append(row)
            if not row['directory']:
                return report  # Never follow an unexpected ancestor symlink.
        except OSError:
            report['ancestors'].append({'depth':depth,'present':False})
            return report
    try:
        before=path.lstat()
        leaf={'present':True,'regular':stat.S_ISREG(before.st_mode),'uid':before.st_uid,'gid':before.st_gid,
              'mode':stat.S_IMODE(before.st_mode),'links':before.st_nlink,'size':before.st_size,
              'device':before.st_dev,'inode':before.st_ino,'symlink':stat.S_ISLNK(before.st_mode),
              'ownerAllowed':before.st_uid in (0,owner_uid),'writeProtected':not bool(before.st_mode & 0o022)}
        report['leaf']=leaf
        report['sizeMatch']=before.st_size==expected_size
        # Metadata may explain a refusal. Hash only a bounded, canonical regular
        # ciphertext file, held with no-follow and rechecked for concurrent change.
        if not (report['canonical'] and safe_chain and leaf['regular'] and leaf['ownerAllowed'] and
                leaf['links']==1 and 0<=before.st_size<=512*1024**2):
            return report
        fields=('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
        identity=lambda item:tuple(getattr(item,k) for k in fields)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            if identity(os.fstat(fd))!=identity(before):
                report['stable']=False;return report
            digest=hashlib.sha256();size=0
            while True:
                raw=os.read(fd,min(1024**2,before.st_size-size+1))
                if not raw:break
                size+=len(raw)
                if size>before.st_size:
                    report['stable']=False;return report
                digest.update(raw)
            report['stable']=(size==before.st_size and identity(os.fstat(fd))==identity(before) and
                              identity(path.lstat())==identity(before) and path.resolve(strict=True)==path)
            if report['stable']:
                report['hashMatch']=digest.hexdigest()==expected_sha
        finally:
            os.close(fd)
    except (OSError, RuntimeError):
        report['hashMatch']='unavailable'
    return report


def inspect_binding(core, guards, scanner, contracts, adapter, preparation):
    checks = dict.fromkeys(CATEGORIES, 'not-run')
    facts = {}
    def check(name, fn, needs=()):
        if any(checks[key] != 'pass' for key in needs):
            return False
        try:
            facts[name] = fn()
            checks[name] = 'pass'
            return True
        except Exception:
            checks[name] = 'fail'
            return False
    def require(value):
        if not value:
            raise ValueError('binding refused')
    def observe_metadata(path):
        # Fixed known paths only; no directory traversal or source imports.
        try:
            row = adapter.evidence_metadata(path)
            return {key: row[key] for key in ('present','kind','uid','gid','mode','links') if key in row}
        except Exception:
            return {'status':'unavailable'}
    def identity():
        require(os.geteuid() == 0 and os.getegid() == 0)
        return pwd.getpwnam('ubuntu')
    state = preparation.STATE
    package = state/'packages'/PACKAGE
    operation = REQUEST['runId']+'-1'
    # Existence is enough for private artifacts; never inspect their contents.
    known = {'package':observe_metadata(package)}
    for label, (sha, _) in preparation.PAIR.items():
        for kind in ('build','runtime'):
            known[label+'-'+kind] = observe_metadata(preparation.WORK/('prepare-'+kind+'-'+operation+'-'+sha))
    for label, path in (('rehearsal',state/'rehearsal-evidence'/operation),
                        ('preimage',state/'rehearsal-evidence'/operation/'preimage.sqlite')):
        known[label] = {'present':os.path.lexists(path)}
    def result():
        return {'schema':'bubblewash-preparation-binding-diagnostic/v1','operation':operation,
                'releaseAcceptance':False,'databaseOpened':False,'hostStateChanged':False,
                'automaticRetry':False,'checks':checks,'retainedPaths':known,
                'archiveDiagnostic':facts.get('ARCHIVE_DIAGNOSTIC',{'status':'not-run'})}
    if not check('IDENTITY',identity):
        return result()
    owner = facts['IDENTITY']
    contract_path = package/'source-contracts.json'
    def contract_check():
        metadata = adapter.protected(contract_path,parents=True)
        with contract_path.open("rb") as handle:
            raw = handle.read(131073)
        require(len(raw)<=131072 and hashlib.sha256(raw).hexdigest()==CONTRACT_SHA and json.loads(raw)==CONTRACT)
        return metadata
    check('PACKAGE_CONTRACT',contract_check)
    def locked_checks(locked):
        check('LOCK',locked)
        def current_check():
            current = core.CURRENT.resolve(strict=True)
            require(core.CURRENT.is_symlink() and current.parent==preparation.WORK)
            return current
        check('CURRENT_POINTER',current_check)
        current = facts.get('CURRENT_POINTER')
        def marker_check():
            marker = guards.inspect_read(core.RUNTIME/'current-release',owner,'current')
            require(core.parse(marker).get('sha')==preparation.LIVE and core.parse(marker).get('path')==str(current))
            return marker
        check('CURRENT_MARKER',marker_check,('CURRENT_POINTER',))
        def release_check():
            raw = guards.inspect_read(current/'.release-sha',owner,'current',128)
            require(raw.decode().strip()==preparation.LIVE)
            return raw
        check('RELEASE_MARKER',release_check,('CURRENT_POINTER',))
        check('SOURCE_TREE',lambda:require(preparation.git_tree(preparation.source_files(current,owner.pw_uid))==preparation.LIVE_TREE),('CURRENT_POINTER',))
        def source_check():
            files,identity = scanner.source_snapshot(current,owner)
            require(scanner.content_commitment(files)==scanner.pins['runtimeContent'] and scanner.pins['runtimeSha']==preparation.LIVE)
            return files,identity
        check('SOURCE_COMMITMENT',source_check,('CURRENT_POINTER',))
        check('ENVIRONMENT_METADATA',lambda:guards.environment_snapshot(core.ENV,owner,None))
        check('ENVIRONMENT_PARSE',lambda:core.parse(facts['ENVIRONMENT_METADATA'][0]),('ENVIRONMENT_METADATA',))
        values = facts.get('ENVIRONMENT_PARSE',{})
        check('SURVEY_CONFIGURATION',lambda:scanner.open_configuration(values),('ENVIRONMENT_PARSE',))
        check('PRODUCTION_CONFIGURATION',lambda:adapter.admit_production_configuration(values),('ENVIRONMENT_PARSE',))
        check('AUTOMATED_UPDATES_DISABLED',lambda:require(values.get('NEXT_PUBLIC_BUBBLEWASH_AUTOMATED_UPDATES_ENABLED')=='false'),('ENVIRONMENT_PARSE',))
        database = Path(values.get('BUBBLEWASH_DATABASE_PATH',''))
        check('DATABASE_LOCATION',lambda:require(not database.is_relative_to(preparation.WORK) and not database.is_relative_to(state)),('ENVIRONMENT_PARSE',))
        check('DATABASE_METADATA',lambda:guards.database_identity(database,owner),('ENVIRONMENT_PARSE','DATABASE_LOCATION'))
        def receipt_check():
            raw = guards.inspect_read(core.RECEIPT,owner,'backup')
            receipt = json.loads(raw)
            require(receipt.get('sha256')==REQUEST['backupSha256'])
            return raw,receipt
        check('BACKUP_RECEIPT',receipt_check)
        if checks['BACKUP_RECEIPT']=='pass' and checks['ENVIRONMENT_PARSE']=='pass':
            receipt_raw,receipt = facts['BACKUP_RECEIPT']
            def archive_check():
                archive = Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR',''))/receipt['filename']
                require(guards.file_identity(archive,owner,REQUEST['backupSha256']) and archive.stat().st_size==receipt['size'])
            check('ARCHIVE_BINDING',archive_check)
            try:
                facts['ARCHIVE_DIAGNOSTIC']=inspect_archive(Path(values.get('BUBBLEWASH_BACKUP_OFFSITE_DIR',''))/receipt['filename'],owner.pw_uid,receipt['size'],REQUEST['backupSha256'])
            except Exception:
                facts['ARCHIVE_DIAGNOSTIC']={'status':'unavailable'}
            check('BACKUP_VERIFICATION',lambda:core.verify_receipt(receipt,json.loads(guards.inspect_read(Path(values.get('BUBBLEWASH_BACKUP_STATUS_PATH','')),owner,'backup')),time.time(),REQUEST['receiptRun'],REQUEST['storeSha'],REQUEST['storeId']))
        def node_check():
            adapter.protected(REQUEST['node']['path'],parents=True)
            require(contracts.digest(REQUEST['node']['path'])==REQUEST['node']['sha256'])
        check('NODE_PIN',node_check)
        check('RUNTIME_FLAGS',lambda:guards.runtime_flags(current,values,True),('CURRENT_POINTER','ENVIRONMENT_PARSE'))
        check('RUNTIME_HEALTH',lambda:core.health(3000))
        check('CONTRACT_RECHECK',lambda:require(contract_check()==facts['PACKAGE_CONTRACT']),('PACKAGE_CONTRACT',))
        check('POINTER_RECHECK',lambda:require(core.CURRENT.resolve(strict=True)==current and marker_check()==facts['CURRENT_MARKER'] and release_check()==facts['RELEASE_MARKER']),('CURRENT_POINTER','CURRENT_MARKER','RELEASE_MARKER'))
        check('SOURCE_RECHECK',lambda:require(scanner.source_snapshot(current,owner)==facts['SOURCE_COMMITMENT']),('SOURCE_COMMITMENT',))
        check('ENVIRONMENT_RECHECK',lambda:require(guards.environment_snapshot(core.ENV,owner,hashlib.sha256(facts['ENVIRONMENT_METADATA'][0]).hexdigest())==facts['ENVIRONMENT_METADATA']),('ENVIRONMENT_METADATA',))
        check('DATABASE_RECHECK',lambda:require(guards.database_identity(database,owner)==facts['DATABASE_METADATA']),('DATABASE_METADATA',))
        check('RECEIPT_RECHECK',lambda:require(guards.inspect_read(core.RECEIPT,owner,'backup')==facts['BACKUP_RECEIPT'][0]),('BACKUP_RECEIPT',))
        check('NODE_RECHECK',node_check,('NODE_PIN',))
        check('LOCK_RECHECK',locked)
    try:
        with core.deployment_lock(core.RUNTIME,owner.pw_uid) as locked:
            locked_checks(locked)
    except Exception:
        checks['LOCK']='fail'
    return result()
