#include <bits/stdc++.h>
using namespace std;
int main(){vector<int>a{3,1,2,5,4};vector<int>t;for(int x:a){auto i=lower_bound(t.begin(),t.end(),x);if(i==t.end())t.push_back(x);else*i=x;}cout<<t.size()<<"\n";}
