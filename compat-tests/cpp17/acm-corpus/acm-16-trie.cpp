#include <bits/stdc++.h>
using namespace std;
struct N{int n[26]{};bool e{};};
int main(){vector<N>t(1);string s="cat";int u=0;for(char c:s){int i=c-'a';int x=t[u].n[i];if(!x){x=(int)t.size();t[u].n[i]=x;t.push_back({});}u=x;}t[u].e=1;u=0;for(char c:string("cat"))u=t[u].n[c-'a'];cout<<t[u].e<<"\n";}
