import tempfile
import unittest
from pathlib import Path
from app import create_app

class AppTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.app=create_app({'TESTING':True,'DATABASE':str(Path(self.tmp.name)/'test.db'),'SECURE_COOKIE':False})
        self.a=self.app.test_client();self.b=self.app.test_client()
    def tearDown(self): self.tmp.cleanup()
    def post(self,client,path,body):
        return client.post('/api/'+path,json=body,headers={'X-Tmrw':'1'})
    def entry(self):
        return dict(today='My diary',rating=4,version=0,yesterday=[dict(text='',done=False) for _ in range(3)],tomorrow=[dict(text='Read a book',done=False) for _ in range(3)])
    def put(self,client,body):
        return client.put('/api/entries/2026-8-23',json=body,headers={'X-Tmrw':'1'})
    def test_accounts_sync_isolation_and_conflict(self):
        self.assertEqual(self.post(self.a,'register',{'password':'my long password 123'}).json['user'],1)
        self.assertEqual(self.post(self.b,'register',{'password':'a different password'}).json['user'],2)
        self.assertEqual(self.put(self.a,self.entry()).json['version'],1)
        self.assertEqual(self.b.get('/api/entries').json['entries'],{})
        other=self.app.test_client()
        self.assertEqual(self.post(other,'login',{'user':'#1','password':'my long password 123'}).status_code,200)
        self.assertEqual(other.get('/api/entries').json['entries']['2026-8-23']['today'],'My diary')
        self.assertEqual(self.put(other,self.entry()).status_code,409)
        self.post(other,'logout',{})
        self.assertEqual(other.get('/api/entries').status_code,401)
    def test_guards(self):
        self.assertEqual(self.a.post('/api/register',json={'password':'long password value'}).status_code,403)
        self.assertEqual(self.post(self.a,'register',{'password':'short'}).status_code,400)
        self.assertEqual(self.post(self.a,'login',{'user':999,'password':'incorrect password'}).status_code,401)
        self.post(self.a,'register',{'password':'long password value'})
        entry=self.entry();entry['rating']=99
        self.assertEqual(self.put(self.a,entry).status_code,400)
        self.assertEqual(self.a.get('/').status_code,200)
        self.assertIn("script-src 'self'", self.a.get('/').headers['Content-Security-Policy'])
    def test_rate_limit(self):
        for _ in range(15): self.post(self.a,'login',{'user':999,'password':'incorrect password'})
        self.assertEqual(self.post(self.a,'login',{'user':999,'password':'incorrect password'}).status_code,429)

if __name__=='__main__':unittest.main()
