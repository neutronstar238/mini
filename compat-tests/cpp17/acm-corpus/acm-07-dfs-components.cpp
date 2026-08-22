#include <bits/stdc++.h>
using namespace std;
int main(){vector<vector<int>>g{{1},{0},{3},{2}};vector<int>v(4);int c=0;function<void(int)>dfs=[&](int u){v[u]=1;for(int x:g[u])if(!v[x])dfs(x);};for(int i=0;i<4;i++)if(!v[i])dfs(i),c++;cout<<c<<"\n";}
