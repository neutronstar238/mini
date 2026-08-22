#include <bits/stdc++.h>
using namespace std;
int main(){vector<int>a{2,1,3};vector<int>s,r(3,-1);for(int i=0;i<3;i++){while(!s.empty()&&a[s.back()]<a[i])r[s.back()]=a[i],s.pop_back();s.push_back(i);}for(int x:r)cout<<x<<' ';}
