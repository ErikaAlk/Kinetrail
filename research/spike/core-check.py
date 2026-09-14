"""离线 SQLite 事务/状态机 spike，不是生产实现或自然语言判别器。"""
import copy
import hashlib
import json
import sqlite3
import tempfile
from contextlib import ExitStack
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def connect(path):
    db = sqlite3.connect(path)
    db.executescript('''
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,owner TEXT,status TEXT,revision INTEGER,summary TEXT);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,owner TEXT,key TEXT,hash TEXT,session TEXT,kind TEXT,raw_text TEXT,payload TEXT,revision INTEGER,UNIQUE(owner,key));
    CREATE TABLE IF NOT EXISTS entries(id TEXT,revision INTEGER,session TEXT,payload TEXT,supersedes INTEGER,PRIMARY KEY(id,revision));
    ''')
    return db


def mutate(db, owner, scopes, key, kind, expected, payload, raw_text='', completion=None, fail=False):
    if 'workout:write' not in scopes:
        raise ValueError('INSUFFICIENT_SCOPE')
    digest = hashlib.sha256(canonical([kind, expected, payload, raw_text, completion]).encode()).hexdigest()
    with db:
        db.execute('BEGIN IMMEDIATE')
        prior = db.execute('SELECT hash,id,revision FROM events WHERE owner=? AND key=?', (owner, key)).fetchone()
        if prior:
            if prior[0] != digest:
                raise ValueError('IDEMPOTENCY_CONFLICT')
            return prior[1:]
        session = db.execute('SELECT owner,status,revision FROM sessions WHERE id=?', ('s1',)).fetchone()
        if session and session[0] != owner:
            raise ValueError('NOT_FOUND')
        if kind == 'record' and completion != 'completed':
            raise ValueError('NEEDS_CLARIFICATION')
        if session is None:
            if kind != 'record' or expected != 0:
                raise ValueError('NOT_FOUND')
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,NULL)', ('s1',owner,'open',0))
            session = (owner, 'open', 0)
        if session[2] != expected:
            raise ValueError('REVISION_CONFLICT')
        if session[1] == 'finalized' and kind == 'record':
            raise ValueError('SESSION_FINALIZED')
        revision = expected + 1
        if kind == 'record':
            db.execute('INSERT INTO entries VALUES(?,?,?,?,NULL)', (key, revision, 's1', canonical(payload)))
        elif kind == 'amend':
            old = db.execute('SELECT revision FROM entries WHERE id=? AND session=? ORDER BY revision DESC LIMIT 1', (payload['target'], 's1')).fetchone()
            if old is None:
                raise ValueError('NOT_FOUND')
            db.execute('INSERT INTO entries VALUES(?,?,?,?,?)', (payload['target'],revision,'s1',canonical(payload['replacement']),old[0]))
        elif kind not in ('finalize', 'reopen'):
            raise ValueError('INVALID_OPERATION')
        if kind == 'finalize':
            db.execute('UPDATE sessions SET summary=? WHERE id=?', (canonical(payload), 's1'))
        status = 'finalized' if kind == 'finalize' else ('open' if kind == 'reopen' else session[1])
        db.execute('UPDATE sessions SET revision=?,status=? WHERE id=?', (revision,status,'s1'))
        event = db.execute('INSERT INTO events(owner,key,hash,session,kind,raw_text,payload,revision) VALUES(?,?,?,?,?,?,?,?)', (owner,key,digest,'s1',kind,raw_text,canonical(payload),revision)).lastrowid
        if fail:
            raise ValueError('SIMULATED_PRECOMMIT_FAILURE')
        return event, revision


def reject(code, fn):
    try:
        fn()
    except ValueError as exc:
        assert str(exc) == code, (str(exc),code)
    else:
        raise AssertionError('必须拒绝 ' + code)


def run():
    data = json.loads((ROOT/'sanitized-fixtures/workout-flow.json').read_text(encoding='utf-8'))['events']
    with tempfile.TemporaryDirectory(prefix='kinetrail-spike-') as temp, ExitStack() as cleanup:
        path = Path(temp)/'fixture.db'
        db = connect(path)
        cleanup.callback(db.close)
        def record(e, rev, **kw):
            return mutate(db,'fixture-owner',{'workout:write'},e['key'],'record',rev,e['entry'],e['raw_text'],e['completion'],**kw)
        reject('NEEDS_CLARIFICATION',lambda: record(data[3],0))
        assert db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 0
        first = record(data[0],0)
        # 提交后的响应丢失：相同 key/payload 返回同一结果，而不是二次插入。
        assert record(data[0],0) == first
        changed = copy.deepcopy(data[0]); changed['entry']['sets'][0]['reps'] = 9
        reject('IDEMPOTENCY_CONFLICT',lambda: record(changed,0))
        reject('REVISION_CONFLICT',lambda: record(data[1],0))
        record(data[1],1)
        reject('SIMULATED_PRECOMMIT_FAILURE',lambda: record(data[2],2,fail=True))
        assert db.execute('SELECT revision FROM sessions').fetchone()[0] == 2
        record(data[2],2)
        reject('NOT_FOUND',lambda: mutate(db,'other-owner',{'workout:write'},'other','finalize',3,{}))
        reject('INSUFFICIENT_SCOPE',lambda: mutate(db,'fixture-owner',{'workout:read'},'ro','finalize',3,{}))
        amended=copy.deepcopy(data[0]['entry']); amended['sets'][0]['load_value']=40
        mutate(db,'fixture-owner',{'workout:write'},'fix','amend',3,{'target':'fixture-1','replacement':amended},'刚才第一组不是45kg，是40kg')
        summary = {'duration_seconds':3600,'duration_source':'user_reported','overall_rpe':8,'notes':'合成总结'}
        mutate(db,'fixture-owner',{'workout:write'},'end','finalize',4,summary,'今天练完了')
        after=copy.deepcopy(data[0]); after['key']='after-finalized'
        reject('SESSION_FINALIZED',lambda: record(after,5))
        db.close()
        # 新数据库连接模拟新进程读回，绝不是 ChatGPT 跨聊天验证。
        db = connect(path)
        cleanup.callback(db.close)
        assert db.execute('SELECT status,revision FROM sessions').fetchone() == ('finalized',5)
        assert json.loads(db.execute('SELECT summary FROM sessions').fetchone()[0]) == summary
        rows=db.execute('SELECT payload FROM entries WHERE id=? ORDER BY revision',('fixture-1',)).fetchall()
        assert [json.loads(r[0])['sets'][0]['load_value'] for r in rows] == [45,40]
        assert json.loads(db.execute('SELECT payload FROM entries WHERE id=?',('fixture-3',)).fetchone()[0]) == data[2]['entry']
        assert db.execute('SELECT COUNT(*) FROM events').fetchone()[0] == 5
        mutate(db,'fixture-owner',{'workout:write'},'reopen','reopen',5,{},'明确重新打开')
        assert db.execute('SELECT status,revision FROM sessions').fetchone() == ('open',6)
        db.close()
    print('PASS SQLite: plan rejection, 3 appends, retry, conflict, rollback, owner/scope, versioned amend, finalize/reopen, independent-connection readback')


if __name__ == '__main__':
    run()
