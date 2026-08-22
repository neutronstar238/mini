#include <bits/stdc++.h>
using namespace std;
struct D{int p[5];D(){iota(p,p+5,0);}int f(int x){return p[x]==x?x:p[x]=f(p[x]);}void u(int a,int b){p[f(a)]=f(b);}};
int main(){D d;d.u(1,2);d.u(2,3);cout<<(d.f(1)==d.f(3))<<"\n";}
