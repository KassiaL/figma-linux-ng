#!/usr/bin/env python3
# Usage: python3 scripts/diag/proc-report.py $(pgrep -o -f /opt/Figma.Linux.NG/figma-linux-ng)
#        (any Electron/Chromium root pid works, e.g. the snap figma-linux one for comparison)
# proc-report.py <root-pid>: per-process type, seccomp, own pid-ns, PSS for an Electron/Chromium tree
import os,sys,re
root=int(sys.argv[1])
def children(p):
    out=[]
    for d in os.listdir('/proc'):
        if d.isdigit():
            try:
                st=open(f'/proc/{d}/stat').read()
                ppid=int(st.rsplit(')',1)[1].split()[1])
                if ppid==p: out.append(int(d))
            except: pass
    return out
def tree(p):
    r=[p]
    for c in children(p): r+=tree(c)
    return r
selfns=os.readlink(f'/proc/{root}/ns/pid')
tot=0
for p in tree(root):
    try:
        cmd=open(f'/proc/{p}/cmdline').read().split('\0')
        full=' '.join(cmd); m=re.search(r'--type=(\S+)',full); t=m.group(1) if m else 'browser'
        m2=re.search(r'--utility-sub-type=(\S+)',full); extra=m2.group(1) if m2 else ''
        sec=re.search(r'Seccomp:\s+(\d)',open(f'/proc/{p}/status').read()).group(1)
        try: ns='own' if os.readlink(f'/proc/{p}/ns/pid')!=selfns else 'host'
        except: ns='?'
        pss=sum(int(l.split()[1]) for l in open(f'/proc/{p}/smaps_rollup') if l.startswith('Pss:'))
        tot+=pss
        print(f"{p:>7} {t+(':'+extra.split('.')[-1] if extra else ''):38} seccomp={sec} pidns={ns:4} PSS={pss/1024:7.1f} MB")
    except Exception as e: print(p,'?',e)
print(f"TOTAL PSS {tot/1024:.0f} MB")
