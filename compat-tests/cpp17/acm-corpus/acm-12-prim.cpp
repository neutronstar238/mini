#include <bits/stdc++.h>
using namespace std;
int main(){vector<vector<pair<int,int>>>g{{{1,2},{2,4}},{{0,2},{2,1}},{{0,4},{1,1}}};vector<int>v(3),d(3,1e9);d[0]=0;int s=0;for(int z=0;z<3;z++){int u=-1;for(int i=0;i<3;i++)if(!v[i]&&(u<0||d[i]<d[u]))u=i;v[u]=1;s+=d[u];for(auto [x,w]:g[u])d[x]=min(d[x],w);}cout<<s<<"\n";}
