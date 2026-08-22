#include <bits/stdc++.h>
using namespace std;
int main(){vector<pair<int,int>>a{{1,3},{2,5},{7,8}};sort(a.begin(),a.end());vector<pair<int,int>>r;for(auto x:a)if(r.empty()||r.back().second<x.first)r.push_back(x);else r.back().second=max(r.back().second,x.second);for(auto [l,u]:r)cout<<l<<'-'<<u<<' ';}
