#include <bits/stdc++.h>
using namespace std;
int main(){vector<vector<int>>g{{1,2},{0,3},{0,3},{1,2}};queue<int>q;q.push(0);vector<int>d(4,-1);d[0]=0;while(!q.empty()){int u=q.front();q.pop();for(int v:g[u])if(d[v]<0)d[v]=d[u]+1,q.push(v);}for(int x:d)cout<<x<<' ';}
