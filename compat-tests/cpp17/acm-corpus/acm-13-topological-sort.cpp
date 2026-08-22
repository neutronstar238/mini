#include <bits/stdc++.h>
using namespace std;
int main(){vector<vector<int>>g{{1},{2},{}};vector<int>in{0,1,1};queue<int>q;q.push(0);while(!q.empty()){int u=q.front();q.pop();cout<<u<<' ';for(int v:g[u])if(!--in[v])q.push(v);}cout<<"\n";}
