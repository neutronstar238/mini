#include <bits/stdc++.h>
using namespace std;
int main(){vector<vector<int>>g{{1},{0,2},{3},{2}};vector<int>v(4),o;function<void(int)>a=[&](int u){v[u]=1;for(int x:g[u])if(!v[x])a(x);o.push_back(u);};for(int i=0;i<4;i++)if(!v[i])a(i);vector<vector<int>>r(4);for(int u=0;u<4;u++)for(int x:g[u])r[x].push_back(u);fill(v.begin(),v.end(),0);reverse(o.begin(),o.end());int c=0;function<void(int)>b=[&](int u){v[u]=1;for(int x:r[u])if(!v[x])b(x);};for(int i:o)if(!v[i])b(i),c++;cout<<c<<"\n";}
