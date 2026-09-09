"""
verify-chain.py — éprouve toute la chaîne de l'API, du premier appel au dernier.

Session, anti-doublon, envoi simple, envoi fractionné, refus attendus, album
partagé, permissions, espace des mariés : trente-deux contrôles qui disent en
quelques secondes si le service est sain.

  npm run dev          (dans un autre terminal)
  npm run verify:api
"""

import json, subprocess, base64, os, sys, time

BASE = "http://localhost:5185"
ok = fail = 0

def curl(args, expect=None, label="", binary=False):
    global ok, fail
    cmd = ["curl","-s","-w","\n%{http_code}"] + (["-o","/dev/null"] if binary else []) + args
    raw = subprocess.run(cmd, capture_output=True).stdout
    out = raw.decode("utf-8", errors="replace")
    body, _, code = out.rpartition("\n")
    code = int(code.strip() or 0)
    good = (expect is None) or (code == expect)
    print(f"  {'✓' if good else '✗'} {label:44} HTTP {code}")
    if not good:
        print(f"      {body[:170]}")
        fail += 1
    else:
        ok += 1
    try: return json.loads(body), code
    except Exception: return body, code

def J(*a): return ["-H","content-type: application/json"] + list(a)
def A(tok): return ["-H", f"authorization: Bearer {tok}"]

jpeg = bytes.fromhex('ffd8ffe000104a46494600010100000100010000ffdb004300ff'*1) + b'\x00'*200
open('/tmp/p.jpg','wb').write(jpeg)
head = base64.b64encode(jpeg[:64]).decode()

print("\n═══ 1. SESSION ═══")
r,_ = curl(["-X","POST",f"{BASE}/api/session"]+J("-d",'{"firstName":"Chaine","lastName":"Complete"}'), 200, "ouverture de session")
tok = r.get("token")
curl(["-X","POST",f"{BASE}/api/session"]+J("-d",'{"firstName":"A","lastName":""}'), 400, "nom incomplet refusé")
r2,_ = curl(["-X","POST",f"{BASE}/api/session"]+J("-d",'{"firstName":"Autre","lastName":"Invite"}'), 200, "seconde session (autre invité)")
tok2 = r2.get("token")

print("\n═══ 2. ANTI-DOUBLON ═══")
curl(["-X","POST",f"{BASE}/api/media/check"]+A(tok)+J("-d",'{"fingerprints":["inconnu"]}'), 200, "vérification d'empreintes")

print("\n═══ 3. ENVOI SIMPLE ═══")
fp = f"fp-{int(time.time())}"
payload = json.dumps({"fingerprint":fp,"name":"photo.jpg","size":len(jpeg),"mime":"image/jpeg","head":head,"source":"gallery","width":1200,"height":900})
r,_ = curl(["-X","POST",f"{BASE}/api/media/init"]+A(tok)+J("-d",payload), 200, "réservation")
mid = r.get("mediaId")
curl(["-X","PUT",f"{BASE}/api/relay/{mid}"]+A(tok)+["-H","content-type: image/jpeg","--data-binary","@/tmp/p.jpg"], 200, "dépôt du fichier")
curl(["-X","POST",f"{BASE}/api/media/{mid}/complete"]+A(tok)+J("-d",'{"parts":[]}'), 200, "clôture")
curl(["-X","PUT",f"{BASE}/api/media/{mid}/thumb"]+A(tok)+["-H","content-type: image/jpeg","--data-binary","@/tmp/p.jpg"], 200, "dépôt de la vignette")

print("\n═══ 4. ENVOI FRACTIONNÉ (fichier lourd) ═══")
big = jpeg + os.urandom(9_000_000)
open('/tmp/big.jpg','wb').write(big)
fp2 = f"fpbig-{int(time.time())}"
payload = json.dumps({"fingerprint":fp2,"name":"lourd.jpg","size":len(big),"mime":"image/jpeg","head":head,"source":"camera"})
r,_ = curl(["-X","POST",f"{BASE}/api/media/init"]+A(tok)+J("-d",payload), 200, "réservation fractionnée")
mid2, parts_total, part_size = r.get("mediaId"), r.get("partsTotal"), r.get("partSize")
print(f"      → {parts_total} parties de {part_size} octets")
etags = []
for n in range(1, (parts_total or 0)+1):
    chunk = big[(n-1)*part_size : n*part_size]
    open(f'/tmp/part{n}.bin','wb').write(chunk)
    rr,_ = curl(["-X","PUT",f"{BASE}/api/relay/{mid2}/{n}"]+A(tok)+["--data-binary",f"@/tmp/part{n}.bin"], 200, f"partie {n}/{parts_total}")
    etags.append({"partNumber":n,"etag":rr.get("etag","")})
curl(["-X","POST",f"{BASE}/api/media/{mid2}/complete"]+A(tok)+J("-d",json.dumps({"parts":etags})), 200, "recomposition")

print("\n═══ 5. REFUS ATTENDUS ═══")
exe = base64.b64encode(b'MZ\x90\x00'+b'\x00'*60).decode()
curl(["-X","POST",f"{BASE}/api/media/init"]+A(tok)+J("-d",json.dumps({"fingerprint":"x1","name":"piege.jpg","size":100,"mime":"image/jpeg","head":exe})), 415, "exécutable déguisé refusé")
curl(["-X","POST",f"{BASE}/api/media/init"]+A(tok)+J("-d",json.dumps({"fingerprint":"x2","name":"a.txt","size":100,"mime":"text/plain","head":head})), 415, "type non accepté refusé")
curl(["-X","POST",f"{BASE}/api/media/init"]+A(tok)+J("-d",json.dumps({"fingerprint":"x3","name":"gros.jpg","size":900*1024*1024,"mime":"image/jpeg","head":head})), 413, "fichier trop lourd refusé")
r,_ = curl(["-X","POST",f"{BASE}/api/media/init"]+A(tok)+J("-d",json.dumps({"fingerprint":fp,"name":"encore.jpg","size":len(jpeg),"mime":"image/jpeg","head":head})), 200, "même fichier reconnu comme doublon")
print(f"      → duplicate = {r.get('duplicate')}")
curl(["-X","POST",f"{BASE}/api/media/init"]+J("-d",'{}'), 401, "sans session refusé")

print("\n═══ 6. ALBUM PARTAGÉ ═══")
r,_ = curl([f"{BASE}/api/gallery?limit=10"]+A(tok), 200, "liste de l'album")
print(f"      → {r.get('total')} souvenirs, {r.get('photos')} photos")
curl([f"{BASE}/api/media/{mid}/thumb"]+A(tok), 200, "aperçu servi", binary=True)
curl([f"{BASE}/api/media/{mid}/file"]+A(tok), 200, "original servi", binary=True)
curl([f"{BASE}/api/media/{mid}/thumb"], 401, "aperçu refusé sans session", binary=True)

print("\n═══ 7. PERMISSIONS ═══")
curl(["-X","DELETE",f"{BASE}/api/media/{mid}"]+A(tok2), 403, "un autre invité ne peut pas supprimer")
curl(["-X","PUT",f"{BASE}/api/media/{mid}/thumb"]+A(tok)+["-H","content-type: image/jpeg","--data-binary","@/tmp/p.jpg"], 409, "vignette non remplaçable")
curl(["-X","PUT",f"{BASE}/api/relay/{mid}"]+A(tok)+["--data-binary","@/tmp/p.jpg"], 409, "fichier non réécrivable")
curl(["-X","DELETE",f"{BASE}/api/media/{mid}"]+A(tok), 200, "l'auteur supprime le sien")

print("\n═══ 8. ESPACE DES MARIÉS ═══")
r,_ = curl(["-X","POST",f"{BASE}/api/admin/login"]+J("-d",'{"password":"ouistitii"}'), 200, "connexion")
atok = r.get("token")
curl(["-X","POST",f"{BASE}/api/admin/login"]+J("-d",'{"password":"faux"}'), 401, "mauvais mot de passe refusé")
curl([f"{BASE}/api/admin/overview"]+A(atok), 200, "vue d'ensemble")
curl([f"{BASE}/api/admin/media?limit=5"]+A(atok), 200, "liste des médias")
curl([f"{BASE}/api/admin/export.csv"]+A(atok), 200, "export CSV", binary=True)
curl(["-X","POST",f"{BASE}/api/admin/cleanup"]+A(atok), 200, "nettoyage")
curl([f"{BASE}/api/admin/overview"], 401, "vue d'ensemble refusée sans jeton")

print(f"\n═══ BILAN : {ok} succès, {fail} échec(s) ═══")
sys.exit(1 if fail else 0)
