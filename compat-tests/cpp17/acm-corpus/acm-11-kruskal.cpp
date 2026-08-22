#include <bits/stdc++.h>
using namespace std;
struct D{vector<int>p;D(int n):p(n){iota(p.begin(),p.end(),0);}int f(int x){return p[x]==x?x:p[x]=f(p[x]);}bool u(int a,int b){a=f(a);b=f(b);if(a==b)return false;p[a]=b;return true;}};
int main(){vector<array<int,3>>e{{1,0,1},{2,1,2},{5,0,2}};sort(e.begin(),e.end());D d(3);int s=0;for(auto [w,a,b]:e)if(d.u(a,b))s+=w;cout<<s<<"\n";}
