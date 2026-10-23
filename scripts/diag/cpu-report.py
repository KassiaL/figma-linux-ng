#!/usr/bin/env python3
# Usage: python3 scripts/diag/cpu-report.py /opt/Figma\ Linux\ NG/figma-linux-ng 10
#        python3 scripts/diag/cpu-report.py /snap/figma-linux/197/figma-linux 10   (old client)
# cpu-tree.py <exe-prefix> <seconds>: CPU% per process type for a process tree
import os,sys,time,re
exe,secs=sys.argv[1],float(sys.argv[2])
def snap():
    info={}
    for d in os.listdir('/proc'):
        if not d.isdigit(): continue
        try:
            st=open(f'/proc/{d}/stat').read(); rest=st[st.rfind(')')+2:].split()
            cmd=open(f'/proc/{d}/cmdline').read().replace('\0',' ')
            info[int(d)]=(int(rest[1]),int(rest[11])+int(rest[12]),cmd)
        except: pass
    root=[p for p,v in info.items() if v[2].startswith(exe+' ') and '--type=' not in v[2]]
    tree=set(root[:1]); g=True
    while g:
        g=False
        for p,v in info.items():
            if p not in tree and v[0] in tree: tree.add(p); g=True
    return {p:info[p] for p in tree}
a=snap(); time.sleep(secs); b=snap()
agg={}
for p,v in b.items():
    if p in a:
        t=(re.search(r'--type=(\S+)',v[2]) or [None,'browser'])[1]
        agg[t]=agg.get(t,0)+(v[1]-a[p][1])/100/secs*100
print({k:round(v,1) for k,v in agg.items()}, 'total', round(sum(agg.values()),1))
