#include <bits/stdc++.h>
using namespace std;
int main(){const int I=1e9;vector<vector<pair<int,int>>>g{{{1,4},{2,1}},{{3,1}},{{1,2},{3,5}},{{}}};vector<int>d(4,I);d[0]=0;priority_queue<pair<int,int>,vector<pair<int,int>>,greater<pair<int,int>>>q;q.push({0,0});while(!q.empty()){auto [du,u]=q.top();q.pop();if(du!=d[u])continue;for(auto [v,w]:g[u])if(d[v]>du+w)d[v]=du+w,q.push({d[v],v});}cout<<d[3]<<"\n";}
